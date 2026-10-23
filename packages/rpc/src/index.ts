// @openrai/rpc — Multi-node RPC, WebSocket, failover, and confirmation tracking

import { NanoClient } from '@openrai/nano-core';
import { EndpointPool, normalizeEndpoints } from '@openrai/nano-core/transport';
import { buildHeaders } from '@openrai/nano-core/transport/http';
import type { EndpointActivityEvent, EndpointAuditRecord, NormalizedEndpoint } from '@openrai/nano-core/transport';
import type { WorkProvider } from '@openrai/nano-core';
import type { ConfirmedBlock } from '@openrai/model';

export interface RpcNodeConfig {
  rpc: string[];
  ws: string[];
}

export interface RpcClient {
  healthCheck(): Promise<void>;
  accountInfo(account: string): Promise<AccountInfoResponse | undefined>;
  accountsReceivable(account: string): Promise<Receivable[]>;
  accountsReceivableBatch(accounts: string[], count: number): Promise<Record<string, string[]>>;
  accountHistory(account: string, count: number, options?: { head?: string; reverse?: boolean }): Promise<AccountHistoryEntry[]>;
  /** Read confirmation state for a published block. */
  blockInfo(hash: string): Promise<BlockInfoResponse | undefined>;
  process(block: string): Promise<ProcessResponse>;
  workGenerate(hash: string): Promise<WorkGenerateResponse>;
  getAuditReport(): EndpointAuditRecord[];
}

export type RpcEndpointHealthStatus = 'healthy' | 'unhealthy';

/** Bounded, operator-facing probe result for one configured Nano RPC URL. */
export interface RpcEndpointHealth {
  url: string;
  status: RpcEndpointHealthStatus;
  checkedAt: string;
  latencyMs: number | null;
  /** The least-expensive RPC action that established reachability. */
  probeAction?: 'version' | 'block_count';
  error?: string;
}

export interface RpcHealthReport {
  status: 'healthy' | 'degraded' | 'down' | 'unconfigured';
  checkedAt: string | null;
  endpoints: RpcEndpointHealth[];
  healthyCount: number;
  failedCount: number;
}

export interface AccountInfoResponse {
  frontier: string;
  balance: string;
  representative: string;
  blockCount: number;
}

export interface Receivable {
  hash: string;
  amount: string;
  sender: string;
}

export interface AccountHistoryEntry {
  type: string;
  subtype?: string;
  account: string;
  linkAsAccount?: string;
  amount: string;
  hash: string;
  link?: string;
  confirmed: boolean;
  localTimestamp?: string;
}

export interface ProcessResponse {
  hash: string;
}

export interface BlockInfoResponse {
  confirmed: boolean;
  subtype?: string;
  blockAccount?: string;
  amount?: string;
  /** Decoded destination for a state send, when the node returns JSON block contents. */
  recipientAccount?: string;
  localTimestamp?: string;
}

export interface WorkGenerateResponse {
  work: string;
}

export interface RpcPool {
  getClient(): RpcClient;
  addNode(config: RpcNodeConfig): void;
  removeNode(rpcUrl: string): void;
  getActiveNode(): RpcClient | undefined;
  onStateChange(listener: (state: RpcPoolState) => void): () => void;
  getAuditReport(): EndpointAuditRecord[];
  /** Probe every configured URL with a short-lived cache to avoid amplification. */
  getHealthReport?(options?: { force?: boolean }): Promise<RpcHealthReport>;
}

export interface RpcPoolState {
  status: 'connected' | 'disconnected' | 'failover';
  activeNode?: RpcNodeConfig;
  previousNode?: RpcNodeConfig;
}

function nodeFromRpcUrl(nodes: RpcNodeConfig[], rpcUrl: string): RpcNodeConfig | undefined {
  return nodes.find((node) => node.rpc.some((url) => safeEndpointUrl(url) === rpcUrl));
}

function configuredRpcUrls(nodes: RpcNodeConfig[]): string[] {
  return nodes.flatMap((node) => node.rpc);
}

function safeEndpointUrl(url: string): string | undefined {
  return normalizeEndpoints({ kind: 'rpc', inputs: [url], defaults: [] })[0]?.url.toString();
}

function isUnsupportedActionError(error: unknown): boolean {
  return /not allowed|not supported|unsupported|unknown action/i.test(String(error));
}


/**
 * A simple promise-based semaphore for limiting concurrency.
 * Callers acquire a slot (waiting if all slots are taken) and release when done.
 */
class Semaphore {
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

const DEFAULT_RPC_TIMEOUT_MS = 15_000;

/**
 * Uses nano-core's supported endpoint normalization, authentication and
 * failover primitives while preserving JSON-RPC application errors for the
 * RaiFlow action adapter. nano-core HttpEndpointPool.postJson treats every
 * JSON `error` as an endpoint failure, which prevents action-level fallbacks.
 */
class NanoCoreRpcTransport {
  private readonly pool: EndpointPool;

  constructor(options: {
    urls?: string[];
    defaults: string[];
    env?: string;
    onActiveEndpointChange?: (event: EndpointActivityEvent) => void;
  }) {
    this.pool = new EndpointPool({
      kind: 'rpc',
      defaults: options.defaults,
      ...(options.urls?.length ? { urls: options.urls } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.onActiveEndpointChange ? { onActiveEndpointChange: options.onActiveEndpointChange } : {}),
    });
  }

  getAuditReport(): EndpointAuditRecord[] {
    return this.pool.getAuditReport();
  }

  async postJson<T extends Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
    return this.pool.execute(async (endpoint: NormalizedEndpoint) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_RPC_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(endpoint.url, {
          method: 'POST',
          headers: buildHeaders(endpoint),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const payload = await response.json().catch(() => undefined) as T | undefined;
      const rpcError = payload && typeof payload === 'object' ? payload.error : undefined;
      if (response.status === 429 || isRateLimitError(rpcError)) {
        throw new Error(`HTTP error 429 rate limited${rpcError === undefined ? '' : `: ${String(rpcError)}`}`);
      }
      if (!response.ok && !isUnsupportedActionError(rpcError)) {
        throw new Error(`HTTP error ${response.status} ${response.statusText}`);
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error(`RPC response from ${endpoint.url.toString()} was not a JSON object`);
      }
      return payload;
    });
  }
}

function isRateLimitError(error: unknown): boolean {
  return error === 429 || /429|rate.?limit|quota/i.test(String(error ?? ''));
}

class PooledRpcClient implements RpcClient {
  constructor(
    private readonly transport: NanoCoreRpcTransport,
    private readonly semaphore: Semaphore,
    private readonly workProvider?: Pick<WorkProvider, 'generate'>,
  ) {}

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
  private async rpcCall<T extends Record<string, unknown>>(
    body: Record<string, unknown>,
  ): Promise<T> {
    await this.semaphore.acquire();
    try {
      return await this.transport.postJson<T>(body);
    } finally {
      this.semaphore.release();
    }
  }

  async healthCheck(): Promise<void> {
    let result = await this.rpcCall<Record<string, unknown>>({ action: 'version' });
    // Some community proxies intentionally deny `version` while allowing the
    // ordinary ledger actions RaiFlow needs. A block-count probe still proves
    // that the upstream is reachable without treating that capability choice
    // as a total outage.
    if (result.error && isUnsupportedActionError(result.error)) {
      result = await this.rpcCall<Record<string, unknown>>({ action: 'block_count' });
      if (result.error) throw new Error(`block_count error: ${String(result.error)}`);
      if (typeof result.count !== 'string' && typeof result.count !== 'number') {
        throw new Error('block_count error: response did not include count');
      }
      return;
    }
    if (result.error) throw new Error(`version error: ${String(result.error)}`);
    if (typeof result.node_vendor !== 'string' || result.node_vendor.length === 0) {
      throw new Error('version error: response did not include node_vendor');
    }
  }

  async accountInfo(account: string): Promise<AccountInfoResponse | undefined> {
    const result = await this.rpcCall<Record<string, unknown>>({
      action: 'account_info',
      account,
      representative: true,
      confirmed: true,
    });
    // "Account not found" is a valid Nano RPC response for unopened accounts.
    if (result.error === 'Account not found') return undefined;
    if (result.error) {
      throw new Error(`account_info error: ${result.error}`);
    }
    return result as unknown as AccountInfoResponse;
  }

  async accountsReceivable(account: string): Promise<Receivable[]> {
    const result = await this.rpcCall<Record<string, unknown>>({
      action: 'accounts_receivable',
      accounts: [account],
      source: true,
      include_only_confirmed: false,
    });
    // Some hosted Nano providers intentionally disable the newer
    // accounts_receivable action while retaining the equivalent pending query.
    // Keep that provider quirk behind RaiFlow's state-aware RPC boundary.
    // "Account not found" simply means zero receivable blocks.
    if (result.error === 'Account not found') return [];
    if (result.error && /not allowed|not supported|unsupported|unknown action/i.test(String(result.error))) {
      const pending = await this.rpcCall<Record<string, unknown>>({
        action: 'pending',
        account,
        source: true,
        include_only_confirmed: false,
        count: 20,
      });
      if (pending.error === 'Account not found') return [];
      if (pending.error) throw new Error(`pending error: ${pending.error}`);
      const pendingBlocks = pending.blocks as Record<string, { amount: string; source?: string; sender?: string }> | undefined;
      if (!pendingBlocks || typeof pendingBlocks !== 'object') return [];
      return Object.entries(pendingBlocks).map(([hash, block]) => ({
        hash,
        amount: block.amount,
        sender: block.source ?? block.sender ?? '',
      }));
    }
    if (result.error) {
      throw new Error(`accounts_receivable error: ${result.error}`);
    }

    const rawBlocks = result.blocks as Record<string, unknown> | undefined;
    if (!rawBlocks) return [];
    // The Nano RPC `accounts_receivable` response is account-scoped:
    // { blocks: { [account]: { [hash]: { amount, source } } } }. Some
    // providers return the inner hash map directly, so accept both forms at
    // this boundary and never leak the account address as a block hash.
    const nested = rawBlocks[account];
    const blocks = (nested && typeof nested === 'object' ? nested : rawBlocks) as Record<string, unknown>;

    return Object.entries(blocks).flatMap(([hash, value]) => {
      if (!value || typeof value !== 'object') return [];
      const block = value as { amount?: unknown; sender?: unknown; source?: unknown };
      if (typeof block.amount !== 'string') return [];
      return [{
        hash,
        amount: block.amount,
        sender: typeof block.sender === 'string' ? block.sender : typeof block.source === 'string' ? block.source : '',
      }];
    });
  }

  async accountsReceivableBatch(accounts: string[], count: number): Promise<Record<string, string[]>> {
    if (accounts.length === 0) return {};
    const result = await this.rpcCall<Record<string, unknown>>({
      action: 'accounts_receivable',
      accounts,
      count: String(count),
      source: true,
      include_only_confirmed: false,
    });
    if (result.error === 'Account not found') return Object.fromEntries(accounts.map((account) => [account, []]));
    if (result.error && isUnsupportedActionError(result.error)) {
      const pending: Array<readonly [string, string[]]> = [];
      for (const [index, account] of accounts.entries()) {
        if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        const response = await this.rpcCall<Record<string, unknown>>({
          action: 'pending', account, count: String(count), threshold: '1', source: true,
        });
        if (response.error === 'Account not found') pending.push([account, []]);
        else {
          if (response.error) throw new Error(`pending error: ${String(response.error)}`);
          const blocks = response.blocks as Record<string, unknown> | undefined;
          pending.push([account, Object.keys(blocks ?? {})]);
        }
      }
      return Object.fromEntries(pending);
    }
    if (result.error) throw new Error(`accounts_receivable error: ${String(result.error)}`);

    const rawBlocks = result.blocks as Record<string, unknown> | undefined;
    return Object.fromEntries(accounts.map((account) => {
      const scoped = rawBlocks?.[account];
      const blocks = scoped && typeof scoped === 'object'
        ? scoped as Record<string, unknown>
        : rawBlocks ?? {};
      return [account, Object.keys(blocks)];
    }));
  }

  async accountHistory(
    account: string,
    count: number,
    options?: { head?: string; reverse?: boolean },
  ): Promise<AccountHistoryEntry[]> {
    const result = await this.rpcCall<Record<string, unknown>>({
      action: 'account_history',
      account,
      count: String(count),
      raw: true,
      ...(options?.head ? { head: options.head } : {}),
      ...(options?.reverse ? { reverse: true } : {}),
    });
    if (result.error) throw new Error(`account_history error: ${String(result.error)}`);
    const history = Array.isArray(result.history) ? result.history as Record<string, unknown>[] : [];
    return history.flatMap((block) => {
      if (typeof block.hash !== 'string' || typeof block.amount !== 'string' || typeof block.account !== 'string') return [];
      return [{
        type: typeof block.type === 'string' ? block.type : '',
        ...(typeof block.subtype === 'string' ? { subtype: block.subtype } : {}),
        account: block.account,
        ...(typeof block.link_as_account === 'string' ? { linkAsAccount: block.link_as_account } : {}),
        amount: block.amount,
        hash: block.hash,
        ...(typeof block.link === 'string' ? { link: block.link } : {}),
        confirmed: block.confirmed === true || block.confirmed === 'true' || block.confirmed === '1',
        ...(typeof block.local_timestamp === 'string' ? { localTimestamp: block.local_timestamp } : {}),
      }];
    });
  }

  async process(block: string): Promise<ProcessResponse> {
    const result = await this.rpcCall<Record<string, unknown>>({ action: 'process', block });
    if (result.error) throw new Error(`process error: ${String(result.error)}`);
    if (typeof result.hash !== 'string' || result.hash.length === 0) {
      throw new Error('process error: response did not include a block hash');
    }
    return { hash: result.hash };
  }

  async blockInfo(hash: string): Promise<BlockInfoResponse | undefined> {
    const result = await this.rpcCall<Record<string, unknown>>({
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
      ? result.contents as Record<string, unknown>
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

  async workGenerate(hash: string): Promise<WorkGenerateResponse> {
    if (!this.workProvider) throw new Error('WorkProvider is not configured');
    return { work: await this.workProvider.generate(hash, 'send') };
  }

  getAuditReport(): EndpointAuditRecord[] {
    return this.transport.getAuditReport();
  }
}

export function createRpcPool(
  nodes: RpcNodeConfig[],
  workProvider?: Pick<WorkProvider, 'generate'>,
): RpcPool {
  const stateListeners = new Set<(state: RpcPoolState) => void>();
  let currentState: RpcPoolState = { status: 'disconnected' };
  let transport: NanoCoreRpcTransport;
  const healthCacheTtlMs = 30_000;
  let healthCache: RpcHealthReport | null = null;
  let healthProbe: Promise<RpcHealthReport> | null = null;

  // One semaphore slot per configured RPC endpoint (minimum 1).
  // This serialises concurrent callers against the pool so a single-endpoint
  // setup never fans out more requests than it can handle, which would trigger
  // cascading cooldown exhaustion ("All endpoints exhausted").
  let semaphore = new Semaphore(Math.max(1, configuredRpcUrls(nodes).length));

  function refreshClient(): void {
    const defaults = NanoClient.initialize().getAuditReport().rpc.map((endpoint) => endpoint.url);
    transport = new NanoCoreRpcTransport({
      urls: configuredRpcUrls(nodes), defaults, env: process.env['NANO_RPC_URL'],
      onActiveEndpointChange: (event) => {
        const activeNode = nodeFromRpcUrl(nodes, event.activeUrl);
        const previousNode = event.previousUrl ? nodeFromRpcUrl(nodes, event.previousUrl) : undefined;
        currentState = { status: event.status, ...(activeNode ? { activeNode } : {}), ...(previousNode ? { previousNode } : {}) };
        for (const listener of stateListeners) listener(currentState);
      },
    });
    semaphore = new Semaphore(Math.max(1, configuredRpcUrls(nodes).length));
    healthCache = null;
  }

  refreshClient();

  function buildClient(): RpcClient {
    return new PooledRpcClient(transport, semaphore, workProvider);
  }

  async function probeEndpoint(url: string): Promise<RpcEndpointHealth> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const probe = new NanoCoreRpcTransport({ urls: [url], defaults: [] });
    try {
      try {
        const result = await probe.postJson<Record<string, unknown>>({ action: 'version' });
        if (result.error && isRateLimitError(result.error)) {
          return { url: safeEndpointUrl(url) ?? url, status: 'healthy', checkedAt, latencyMs: Date.now() - startedAt, probeAction: 'version' };
        }
        if (result.error) throw new Error(String(result.error));
        return {
          url: safeEndpointUrl(url) ?? url,
          status: 'healthy',
          checkedAt,
          latencyMs: Date.now() - startedAt,
          probeAction: 'version',
        };
      } catch (error) {
        if (!isUnsupportedActionError(error)) {
          if (isRateLimitError(error)) {
            return { url: safeEndpointUrl(url) ?? url, status: 'healthy', checkedAt, latencyMs: Date.now() - startedAt, probeAction: 'version' };
          }
          throw error;
        }
        await probe.postJson<Record<string, unknown>>({ action: 'block_count' });
        return {
          url: safeEndpointUrl(url) ?? url,
          status: 'healthy',
          checkedAt,
          latencyMs: Date.now() - startedAt,
          probeAction: 'block_count',
        };
      }
    } catch (error) {
      return {
        url: safeEndpointUrl(url) ?? url,
        status: 'unhealthy',
        checkedAt,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function getHealthReport(options?: { force?: boolean }): Promise<RpcHealthReport> {
    const urls = transport.getAuditReport().map((endpoint) => endpoint.url);
    const now = Date.now();
    if (!options?.force && healthCache && healthCache.checkedAt && now - Date.parse(healthCache.checkedAt) < healthCacheTtlMs) {
      return healthCache;
    }
    if (healthProbe) return healthProbe;

    healthProbe = (async () => {
      if (urls.length === 0) {
        return {
          status: 'unconfigured',
          checkedAt: new Date().toISOString(),
          endpoints: [],
          healthyCount: 0,
          failedCount: 0,
        } satisfies RpcHealthReport;
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
      } satisfies RpcHealthReport;
    })().then((report) => {
      healthCache = report;
      return report;
    }).finally(() => {
      healthProbe = null;
    });

    return healthProbe;
  }

  return {
    getClient(): RpcClient {
      return buildClient();
    },

    addNode(config: RpcNodeConfig): void {
      const existing = nodes.findIndex((n) => n.rpc.some((url) => config.rpc.includes(url)));
      if (existing >= 0) nodes[existing] = config;
      else nodes.push(config);
      refreshClient();
    },

    removeNode(rpcUrl: string): void {
      const idx = nodes.findIndex((n) => n.rpc.includes(rpcUrl));
      if (idx < 0) return;
      nodes.splice(idx, 1);
      refreshClient();
      if (nodes.length === 0 && transport.getAuditReport().length === 0) {
        currentState = { status: 'disconnected' };
        for (const listener of stateListeners) listener(currentState);
      }
    },

    getActiveNode(): RpcClient | undefined {
      if (configuredRpcUrls(nodes).length === 0 && transport.getAuditReport().length === 0) return undefined;
      return buildClient();
    },

    onStateChange(listener: (state: RpcPoolState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    getAuditReport(): EndpointAuditRecord[] {
      return transport.getAuditReport();
    },

    getHealthReport,
  };
}

export interface WsClient {
  connect(accounts: string[]): Promise<void>;
  disconnect(): void;
  addAccount(account: string): void;
  removeAccount(account: string): void;
  onConfirmation(listener: (block: ConfirmedBlock) => void): () => void;
  getAuditReport(): EndpointAuditRecord[];
}

export function createWsClient(wsUrl?: string): WsClient {
  const client = NanoClient.initialize({
    ...(wsUrl ? { ws: [wsUrl] } : {}),
  });

  let ws: WebSocket | null = null;
  const accounts = new Set<string>();
  const confirmationListeners = new Set<(block: ConfirmedBlock) => void>();

  async function establish(): Promise<void> {
    ws = await client.wsPool.connect();
    const socket = ws;
    if (!socket) throw new Error('WebSocket connection failed');
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        if (msg.topic === 'confirmation' && msg.message) {
          const m = msg.message as Record<string, unknown>;
          const block = m.block as Record<string, unknown> | undefined;
          if (!block) return;
          const confirmedBlock: ConfirmedBlock = {
            blockHash: block.hash as string,
            senderAccount: (block.account as string) ?? '',
            recipientAccount: (block.contents as string) ?? '',
            amountRaw: m.amount as string,
            confirmedAt: new Date().toISOString(),
          };
          for (const listener of confirmationListeners) listener(confirmedBlock);
        }
      } catch {
        // ignore parse errors
      }
    };
  }

  return {
    async connect(accounts_: string[]): Promise<void> {
      for (const account of accounts_) accounts.add(account);
      await establish();

      if (ws && accounts.size > 0) {
        ws.send(JSON.stringify({
          action: 'subscribe',
          topic: 'confirmation',
          options: { accounts: [...accounts], include_block: true },
        }));
      }
    },

    disconnect(): void {
      if (ws) ws.close();
      ws = null;
    },

    addAccount(account: string): void {
      accounts.add(account);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'subscribe',
          topic: 'confirmation',
          options: { accounts: [account], include_block: true },
        }));
      }
    },

    removeAccount(account: string): void {
      accounts.delete(account);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'unsubscribe',
          topic: 'confirmation',
          options: { accounts: [account] },
        }));
      }
    },

    onConfirmation(listener: (block: ConfirmedBlock) => void): () => void {
      confirmationListeners.add(listener);
      return () => confirmationListeners.delete(listener);
    },

    getAuditReport(): EndpointAuditRecord[] {
      return client.wsPool.getAuditReport();
    },
  };
}
