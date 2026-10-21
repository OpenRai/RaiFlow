// @openrai/rpc — Multi-node RPC, WebSocket, failover, and confirmation tracking
import { NanoClient } from '@openrai/nano-core';
import { generateWork as rspowGenerate, WorkType } from 'nano-rspow-node';
function nodeFromRpcUrl(nodes, rpcUrl) {
    return nodes.find((node) => node.rpc.includes(rpcUrl));
}
function configuredRpcUrls(nodes) {
    return nodes.flatMap((node) => node.rpc);
}
function configuredWsUrls(nodes) {
    return nodes.flatMap((node) => node.ws);
}
function isUnsupportedActionError(error) {
    return /not allowed|not supported|unsupported|unknown action/i.test(String(error));
}
/**
 * A simple promise-based semaphore for limiting concurrency.
 * Callers acquire a slot (waiting if all slots are taken) and release when done.
 */
class Semaphore {
    concurrency;
    queue = [];
    running = 0;
    constructor(concurrency) {
        this.concurrency = concurrency;
    }
    acquire() {
        if (this.running < this.concurrency) {
            this.running++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(resolve);
        });
    }
    release() {
        const next = this.queue.shift();
        if (next) {
            next();
        }
        else {
            this.running--;
        }
    }
}
class PooledRpcClient {
    client;
    semaphore;
    constructor(client, semaphore) {
        this.client = client;
        this.semaphore = semaphore;
    }
    /**
     * Low-level RPC call that returns raw JSON responses without throwing on
     * application-level errors (e.g. "Account not found"). Only transport errors
     * (HTTP failures, network errors, timeouts) propagate as exceptions and are
     * recorded by the EndpointPool.
     *
     * This prevents Nano RPC application errors from poisoning the endpoint pool's
     * cooldown state — which would otherwise cause "All endpoints exhausted" cascades.
     *
     * Requests are serialized through a semaphore sized to the number of configured
     * endpoints, so a single-endpoint pool never overwhelms the EndpointPool with
     * concurrent failures that trigger cascading cooldown exhaustion.
     */
    async rpcCall(body) {
        await this.semaphore.acquire();
        try {
            return await this._rpcCallInner(body);
        }
        finally {
            this.semaphore.release();
        }
    }
    async _rpcCallInner(body) {
        // Access the internal EndpointPool and timeout from the HttpEndpointPool.
        // These are public fields in nano-core's compiled output.
        const rpcPool = this.client.rpcPool;
        const endpointPool = rpcPool.pool;
        const timeoutMs = rpcPool.timeoutMs;
        return endpointPool.execute(async (ep) => {
            const endpoint = ep;
            // Build headers (mirrors nano-core's buildHeaders logic)
            const headers = {
                'Content-Type': 'application/json',
            };
            if (endpoint.auth.type === 'api-key' && endpoint.auth.value) {
                if (endpoint.auth.policy === 'basic-header') {
                    headers['Authorization'] = `Basic ${btoa(`${endpoint.auth.value}:`)}`;
                }
                else {
                    headers['Authorization'] = `Bearer ${endpoint.auth.value}`;
                }
            }
            const controller = timeoutMs !== null ? new AbortController() : null;
            const timer = controller && timeoutMs !== null
                ? setTimeout(() => controller.abort(), timeoutMs)
                : null;
            let response;
            try {
                response = await fetch(endpoint.url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    ...(controller ? { signal: controller.signal } : {}),
                });
            }
            finally {
                if (timer !== null)
                    clearTimeout(timer);
            }
            if (!response.ok) {
                // Hosted providers sometimes return a Nano application error (for
                // example, an unsupported action) with HTTP 500. Preserve that JSON
                // so the operation-level adapter can apply a protocol fallback. A
                // 429 remains a transport/rate-limit failure for endpoint backoff.
                if (response.status !== 429) {
                    const payload = await response.json().catch(() => undefined);
                    if (payload && typeof payload === 'object' && 'error' in payload) {
                        return payload;
                    }
                }
                throw new Error(`HTTP error ${response.status} ${response.statusText}`);
            }
            const json = (await response.json());
            // Providers commonly report rate limiting as an HTTP-200 Nano RPC
            // payload (`{"error":429}`) rather than an HTTP 429 response. Treat
            // that as endpoint failure so the pool can fail over instead of leaking
            // an application error to every caller.
            if (json && json.error === 429) {
                throw new Error('HTTP error 429 rate limited');
            }
            // Return the raw JSON — including any `error` field.
            // The caller decides how to handle application-level errors.
            // Transport errors (above) are the only ones that poison the pool.
            return json;
        });
    }
    async healthCheck() {
        let result = await this.rpcCall({ action: 'version' });
        // Some community proxies intentionally deny `version` while allowing the
        // ordinary ledger actions RaiFlow needs. A block-count probe still proves
        // that the upstream is reachable without treating that capability choice
        // as a total outage.
        if (result.error && isUnsupportedActionError(result.error)) {
            result = await this.rpcCall({ action: 'block_count' });
            if (result.error)
                throw new Error(`block_count error: ${String(result.error)}`);
            if (typeof result.count !== 'string' && typeof result.count !== 'number') {
                throw new Error('block_count error: response did not include count');
            }
            return;
        }
        if (result.error)
            throw new Error(`version error: ${String(result.error)}`);
        if (typeof result.node_vendor !== 'string' || result.node_vendor.length === 0) {
            throw new Error('version error: response did not include node_vendor');
        }
    }
    async accountInfo(account) {
        const result = await this.rpcCall({
            action: 'account_info',
            account,
            representative: true,
            confirmed: true,
        });
        // "Account not found" is a valid Nano RPC response for unopened accounts.
        if (result.error === 'Account not found')
            return undefined;
        if (result.error) {
            throw new Error(`account_info error: ${result.error}`);
        }
        return result;
    }
    async accountsReceivable(account) {
        const result = await this.rpcCall({
            action: 'accounts_receivable',
            accounts: [account],
            source: true,
            include_only_confirmed: false,
        });
        // Some hosted Nano providers intentionally disable the newer
        // accounts_receivable action while retaining the equivalent pending query.
        // Keep that provider quirk behind RaiFlow's state-aware RPC boundary.
        // "Account not found" simply means zero receivable blocks.
        if (result.error === 'Account not found')
            return [];
        if (result.error && /not allowed|not supported|unsupported|unknown action/i.test(String(result.error))) {
            const pending = await this.rpcCall({
                action: 'pending',
                account,
                source: true,
                include_only_confirmed: false,
                count: 20,
            });
            if (pending.error === 'Account not found')
                return [];
            if (pending.error)
                throw new Error(`pending error: ${pending.error}`);
            const pendingBlocks = pending.blocks;
            if (!pendingBlocks || typeof pendingBlocks !== 'object')
                return [];
            return Object.entries(pendingBlocks).map(([hash, block]) => ({
                hash,
                amount: block.amount,
                sender: block.source ?? block.sender ?? '',
            }));
        }
        if (result.error) {
            throw new Error(`accounts_receivable error: ${result.error}`);
        }
        const rawBlocks = result.blocks;
        if (!rawBlocks)
            return [];
        // The Nano RPC `accounts_receivable` response is account-scoped:
        // { blocks: { [account]: { [hash]: { amount, source } } } }. Some
        // providers return the inner hash map directly, so accept both forms at
        // this boundary and never leak the account address as a block hash.
        const nested = rawBlocks[account];
        const blocks = (nested && typeof nested === 'object' ? nested : rawBlocks);
        return Object.entries(blocks).flatMap(([hash, value]) => {
            if (!value || typeof value !== 'object')
                return [];
            const block = value;
            if (typeof block.amount !== 'string')
                return [];
            return [{
                    hash,
                    amount: block.amount,
                    sender: typeof block.sender === 'string' ? block.sender : typeof block.source === 'string' ? block.source : '',
                }];
        });
    }
    async process(block) {
        const result = await this.rpcCall({ action: 'process', block });
        if (result.error)
            throw new Error(`process error: ${String(result.error)}`);
        if (typeof result.hash !== 'string' || result.hash.length === 0) {
            throw new Error('process error: response did not include a block hash');
        }
        return { hash: result.hash };
    }
    async blockInfo(hash) {
        const result = await this.rpcCall({
            action: 'block_info',
            hash,
            json_block: true,
        });
        // A block can be accepted by a node before it is visible to every
        // confirmation query. Treat that normal propagation window as unknown.
        if (result.error && /block not found|not found/i.test(String(result.error))) {
            return undefined;
        }
        if (result.error) {
            throw new Error(`block_info error: ${String(result.error)}`);
        }
        const confirmed = result.confirmed === true || result.confirmed === 'true' || result.confirmed === '1';
        const contents = result.contents && typeof result.contents === 'object'
            ? result.contents
            : undefined;
        return {
            confirmed,
            ...(typeof result.subtype === 'string' ? { subtype: result.subtype } : {}),
            ...(typeof result.block_account === 'string' ? { blockAccount: result.block_account } : {}),
            ...(typeof result.amount === 'string' ? { amount: result.amount } : {}),
            ...(typeof contents?.link_as_account === 'string' ? { recipientAccount: contents.link_as_account } : {}),
            ...(typeof result.local_timestamp === 'string' ? { localTimestamp: result.local_timestamp } : {}),
        };
    }
    async workGenerate(hash) {
        return { work: await rspowGenerate(hash, WorkType.Send) };
    }
    getAuditReport() {
        return this.client.rpcPool.getAuditReport();
    }
}
export function createRpcPool(nodes) {
    const stateListeners = new Set();
    let currentState = { status: 'disconnected' };
    let detachEndpointListener = () => { };
    let client = NanoClient.initialize(buildClientOptions(nodes));
    const healthCacheTtlMs = 30_000;
    let healthCache = null;
    let healthProbe = null;
    // One semaphore slot per configured RPC endpoint (minimum 1).
    // This serialises concurrent callers against the pool so a single-endpoint
    // setup never fans out more requests than it can handle, which would trigger
    // cascading cooldown exhaustion ("All endpoints exhausted").
    let semaphore = new Semaphore(Math.max(1, configuredRpcUrls(nodes).length));
    function buildClientOptions(configuredNodes) {
        const rpc = configuredRpcUrls(configuredNodes);
        const ws = configuredWsUrls(configuredNodes);
        return {
            ...(rpc.length > 0 ? { rpc } : {}),
            ...(ws.length > 0 ? { ws } : {}),
        };
    }
    function refreshClient() {
        detachEndpointListener();
        client = NanoClient.initialize(buildClientOptions(nodes));
        semaphore = new Semaphore(Math.max(1, configuredRpcUrls(nodes).length));
        healthCache = null;
        detachEndpointListener = client.onEndpointChange((event) => {
            if (event.kind !== 'rpc')
                return;
            const activeNode = nodeFromRpcUrl(nodes, event.activeUrl);
            const previousNode = event.previousUrl ? nodeFromRpcUrl(nodes, event.previousUrl) : undefined;
            currentState = {
                status: event.status,
                ...(activeNode ? { activeNode } : {}),
                ...(previousNode ? { previousNode } : {}),
            };
            for (const listener of stateListeners)
                listener(currentState);
        });
    }
    refreshClient();
    function buildClient() {
        return new PooledRpcClient(client, semaphore);
    }
    async function probeEndpoint(url) {
        const startedAt = Date.now();
        const checkedAt = new Date().toISOString();
        const probe = NanoClient.initialize({ rpc: [url], warn: () => { } });
        try {
            try {
                await probe.rpcPool.postJson({ action: 'version' });
                return {
                    url,
                    status: 'healthy',
                    checkedAt,
                    latencyMs: Date.now() - startedAt,
                    probeAction: 'version',
                };
            }
            catch (error) {
                if (!isUnsupportedActionError(error))
                    throw error;
                await probe.rpcPool.postJson({ action: 'block_count' });
                return {
                    url,
                    status: 'healthy',
                    checkedAt,
                    latencyMs: Date.now() - startedAt,
                    probeAction: 'block_count',
                };
            }
        }
        catch (error) {
            return {
                url,
                status: 'unhealthy',
                checkedAt,
                latencyMs: Date.now() - startedAt,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    async function getHealthReport(options) {
        const urls = configuredRpcUrls(nodes);
        const now = Date.now();
        if (!options?.force && healthCache && healthCache.checkedAt && now - Date.parse(healthCache.checkedAt) < healthCacheTtlMs) {
            return healthCache;
        }
        if (healthProbe)
            return healthProbe;
        healthProbe = (async () => {
            if (urls.length === 0) {
                return {
                    status: 'unconfigured',
                    checkedAt: new Date().toISOString(),
                    endpoints: [],
                    healthyCount: 0,
                    failedCount: 0,
                };
            }
            // Probe in parallel once per cache window. This is bounded by the
            // configured endpoint count and prevents dashboard refreshes from
            // multiplying traffic to a provider.
            const endpoints = await Promise.all(urls.map((url) => probeEndpoint(url)));
            const healthyCount = endpoints.filter((endpoint) => endpoint.status === 'healthy').length;
            return {
                status: healthyCount === 0 ? 'down' : healthyCount === endpoints.length ? 'healthy' : 'degraded',
                checkedAt: new Date().toISOString(),
                endpoints,
                healthyCount,
                failedCount: endpoints.length - healthyCount,
            };
        })().then((report) => {
            healthCache = report;
            return report;
        }).finally(() => {
            healthProbe = null;
        });
        return healthProbe;
    }
    return {
        getClient() {
            return buildClient();
        },
        addNode(config) {
            const existing = nodes.findIndex((n) => n.rpc.some((url) => config.rpc.includes(url)));
            if (existing >= 0)
                nodes[existing] = config;
            else
                nodes.push(config);
            refreshClient();
        },
        removeNode(rpcUrl) {
            const idx = nodes.findIndex((n) => n.rpc.includes(rpcUrl));
            if (idx < 0)
                return;
            nodes.splice(idx, 1);
            refreshClient();
            if (nodes.length === 0 && client.getAuditReport().rpc.length === 0) {
                currentState = { status: 'disconnected' };
                for (const listener of stateListeners)
                    listener(currentState);
            }
        },
        getActiveNode() {
            if (configuredRpcUrls(nodes).length === 0 && client.getAuditReport().rpc.length === 0)
                return undefined;
            return buildClient();
        },
        onStateChange(listener) {
            stateListeners.add(listener);
            return () => stateListeners.delete(listener);
        },
        getAuditReport() {
            return client.rpcPool.getAuditReport();
        },
        getHealthReport,
    };
}
export function createWsClient(wsUrl) {
    const client = NanoClient.initialize({
        ...(wsUrl ? { ws: [wsUrl] } : {}),
    });
    let ws = null;
    const accounts = new Set();
    const confirmationListeners = new Set();
    async function establish() {
        ws = await client.wsPool.connect();
        const socket = ws;
        if (!socket)
            throw new Error('WebSocket connection failed');
        socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.topic === 'confirmation' && msg.message) {
                    const m = msg.message;
                    const block = m.block;
                    if (!block)
                        return;
                    const confirmedBlock = {
                        blockHash: block.hash,
                        senderAccount: block.account ?? '',
                        recipientAccount: block.contents ?? '',
                        amountRaw: m.amount,
                        confirmedAt: new Date().toISOString(),
                    };
                    for (const listener of confirmationListeners)
                        listener(confirmedBlock);
                }
            }
            catch {
                // ignore parse errors
            }
        };
    }
    return {
        async connect(accounts_) {
            for (const account of accounts_)
                accounts.add(account);
            await establish();
            if (ws && accounts.size > 0) {
                ws.send(JSON.stringify({
                    action: 'subscribe',
                    topic: 'confirmation',
                    options: { accounts: [...accounts], include_block: true },
                }));
            }
        },
        disconnect() {
            if (ws)
                ws.close();
            ws = null;
        },
        addAccount(account) {
            accounts.add(account);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'subscribe',
                    topic: 'confirmation',
                    options: { accounts: [account], include_block: true },
                }));
            }
        },
        removeAccount(account) {
            accounts.delete(account);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    action: 'unsubscribe',
                    topic: 'confirmation',
                    options: { accounts: [account] },
                }));
            }
        },
        onConfirmation(listener) {
            confirmationListeners.add(listener);
            return () => confirmationListeners.delete(listener);
        },
        getAuditReport() {
            return client.wsPool.getAuditReport();
        },
    };
}
//# sourceMappingURL=index.js.map