// @openrai/runtime — Framework-agnostic HTTP handler
import { randomUUID } from 'node:crypto';
import { isErrorWithCode } from '@openrai/model';
import { renderDashboard } from './dashboard.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function errorResponse(message, code, status) {
    return json({ error: { message, code } }, status);
}
function withRequestId(response, requestId) {
    response.headers.set('X-Request-Id', requestId);
    return response;
}
function parseRoute(req) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
    const method = req.method.toUpperCase();
    return { url, parts, method };
}
function handleRaiFlowError(err) {
    if (isErrorWithCode(err)) {
        const statusMap = {
            not_found: 404,
            bad_request: 400,
            conflict: 409,
        };
        const status = statusMap[err.code];
        if (status !== undefined) {
            return errorResponse(err.message, err.code, status);
        }
    }
    return undefined;
}
/** Extract a path segment from a URL pathname. Returns `undefined` if not present. */
function getPathSegment(parts, index) {
    return parts[index];
}
function idempotencyKey(req) {
    const value = req.headers.get('Idempotency-Key')?.trim();
    return value || undefined;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create a framework-agnostic HTTP request handler backed by a `Runtime` instance.
 *
 * @example
 * ```ts
 * const runtime = new Runtime();
 * runtime.start();
 * const handler = createHandler(runtime);
 *
 * // Use with Node.js http module, Deno.serve, Bun.serve, etc.
 * const response = await handler(request);
 * ```
 */
function checkAuth(req, config) {
    const apiKey = config.daemon.apiKey;
    const { parts, method } = parseRoute(req);
    // Exempt wayfinder (GET /)
    if (method === 'GET' && parts.length === 0) {
        return undefined;
    }
    // Health endpoints are intentionally unauthenticated for orchestrator probes.
    if (method === 'GET' && parts.length === 2 && parts[0] === 'health' && (parts[1] === 'live' || parts[1] === 'ready')) {
        return undefined;
    }
    if (method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'version') {
        return undefined;
    }
    // Exempt dashboard (GET /dashboard) if configured
    if (config.daemon.enableDashboardAuth === false && method === 'GET' && parts.length === 1 && parts[0] === 'dashboard') {
        return undefined;
    }
    if (!apiKey)
        return undefined;
    const authHeader = req.headers.get('authorization') ?? '';
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || match[1] !== apiKey) {
        return errorResponse('Unauthorized', 'unauthorized', 401);
    }
    return undefined;
}
export function createHandler(runtime, config, version, accountStateSync, subscriptionManager) {
    return async (req) => {
        const requestId = req.headers.get('x-request-id')?.trim() || randomUUID();
        try {
            const authFailure = checkAuth(req, config);
            if (authFailure)
                return withRequestId(authFailure, requestId);
            const response = await route(req, runtime, config, version, accountStateSync, subscriptionManager);
            return withRequestId(response, requestId);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Internal server error';
            return withRequestId(errorResponse(message, 'internal_error', 500), requestId);
        }
    };
}
async function route(req, runtime, config, version, accountStateSync, subscriptionManager) {
    const { url, parts, method } = parseRoute(req);
    // GET / — wayfinder (static landing page)
    if (method === 'GET' && parts.length === 0) {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RaiFlow</title>
  <style>
    :root { --bg: #0a0a0c; --text: #fff; --muted: #9494a0; --accent: #4a90e2; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: var(--bg); color: var(--text); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { text-align: center; }
    h1 { font-size: 2.4rem; margin: 0 0 8px; }
    p { color: var(--muted); margin: 0 0 32px; }
    .links { display: flex; gap: 16px; justify-content: center; }
    a { display: inline-block; padding: 12px 24px; border-radius: 12px; text-decoration: none; font-weight: 600; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: var(--text); transition: background 0.15s; }
    a:hover { background: rgba(74,144,226,0.15); border-color: rgba(74,144,226,0.4); }
  </style>
</head>
<body>
  <main class="card">
    <h1>RaiFlow</h1>
    <p>Nano payment runtime</p>
    <div class="links">
      <a href="/dashboard">Dashboard</a>
      <a href="/health/ready">API Health</a>
    </div>
  </main>
</body>
</html>`;
        return new Response(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
    // /dashboard — SSR dashboard
    if (parts[0] === 'dashboard' && method === 'GET') {
        const html = await renderDashboard(runtime, {
            view: url.searchParams.get('view') ?? undefined,
            config,
            metrics: globalThis.__RAIFLOW_METRICS__,
            showInternal: url.searchParams.get('showInternal') === 'true',
            version,
        });
        return new Response(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    }
    if (method === 'GET' && parts.length === 2 && parts[0] === 'health' && parts[1] === 'live') {
        return json({ status: 'ok' });
    }
    if (method === 'GET' && parts.length === 2 && parts[0] === 'health' && parts[1] === 'ready') {
        let rpcReady = false;
        try {
            const client = runtime.rpcPool?.getClient();
            if (client) {
                await client.healthCheck();
                rpcReady = true;
            }
        }
        catch {
            rpcReady = false;
        }
        const accountsReady = accountStateSync?.isInitialSyncComplete() ?? true;
        const ready = rpcReady && accountsReady;
        return json({ status: ready ? 'ready' : 'not_ready', checks: { rpc: rpcReady, accounts: accountsReady } }, ready ? 200 : 503);
    }
    // v3 exposes one canonical API prefix. Legacy /api routes intentionally 404.
    if (parts[0] === 'v1') {
        return routeApi(parts.slice(1), url, method, req, runtime, version, accountStateSync, subscriptionManager);
    }
    // No route matched
    return errorResponse('Not found', 'not_found', 404);
}
async function routeApi(parts, url, method, req, runtime, version, accountStateSync, subscriptionManager) {
    // GET /v1/version
    if (method === 'GET' && parts.length === 1 && parts[0] === 'version') {
        return json({ version: version ?? 'dev' });
    }
    // ---------------------------------------------------------------------------
    // Accounts
    // ---------------------------------------------------------------------------
    if (parts[0] === 'accounts') {
        // GET /api/accounts/stream — SSE endpoint
        if (method === 'GET' && parts.length === 2 && parts[1] === 'stream') {
            if (!subscriptionManager) {
                return errorResponse('Streaming not configured', 'bad_request', 400);
            }
            const streamId = randomUUID();
            const accountsParam = url.searchParams.get('accounts') ?? undefined;
            let closed = false;
            let heartbeat;
            let sseController;
            const stream = new ReadableStream({
                start: (controller) => {
                    heartbeat = setInterval(() => {
                        if (closed)
                            return;
                        try {
                            controller.enqueue(new TextEncoder().encode(':keepalive\n\n'));
                        }
                        catch {
                            closed = true;
                            if (heartbeat !== undefined)
                                clearInterval(heartbeat);
                        }
                    }, 15_000);
                    if (typeof heartbeat === 'object' && heartbeat !== null && 'unref' in heartbeat) {
                        heartbeat.unref();
                    }
                    const connection = {
                        id: streamId,
                        enqueue(event) {
                            if (closed)
                                return;
                            controller.enqueue(new TextEncoder().encode(event));
                        },
                        close() {
                            closed = true;
                            if (heartbeat !== undefined)
                                clearInterval(heartbeat);
                            controller.close();
                        },
                        get closed() {
                            return closed;
                        },
                    };
                    // Always register the connection so watch/unwatch REST calls can find it
                    sseController = connection;
                    subscriptionManager.register(connection);
                    if (accountsParam && accountStateSync) {
                        const addresses = accountsParam.split(',').map((a) => a.trim()).filter(Boolean);
                        for (const addr of addresses) {
                            // Subscribe first — client receives events from reconciliation immediately
                            subscriptionManager.subscribe(addr, connection);
                            // Add to watcher in background — 30s reconciliation handles retry
                            accountStateSync.addAccount(addr).catch(() => { });
                        }
                    }
                    // Send an initial frame to establish the connection immediately and
                    // tell EventSource-compatible clients how quickly to retry.
                    controller.enqueue(new TextEncoder().encode('retry: 5000\n:ok\n\n'));
                    req.signal.addEventListener('abort', () => {
                        closed = true;
                        clearInterval(heartbeat);
                        subscriptionManager.removeConnection(connection);
                    });
                },
                cancel: () => {
                    // The request abort handler normally performs cleanup; cancel also
                    // covers adapters that cancel a ReadableStream without aborting the
                    // original Request signal.
                    closed = true;
                    if (heartbeat !== undefined)
                        clearInterval(heartbeat);
                    if (sseController)
                        subscriptionManager.removeConnection(sseController);
                },
            });
            return new Response(stream, {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                    'X-Raiflow-Stream-Id': streamId,
                },
            });
        }
        // POST /api/accounts
        if (method === 'POST' && parts.length === 1) {
            const body = await req.json();
            const { type, accountKey, label, representative, address } = body;
            const mutationKey = idempotencyKey(req);
            if (!mutationKey)
                return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
            if (type !== 'managed' && type !== 'watched') {
                return errorResponse('Missing or invalid field: type (must be "managed" or "watched")', 'bad_request', 400);
            }
            if (type === 'managed' && runtime.mode === 'non-custodial') {
                return errorResponse('Managed accounts are not available in non-custodial mode. Use type "watched" instead.', 'not_implemented', 501);
            }
            try {
                if (type === 'managed') {
                    if (typeof accountKey !== 'string' || accountKey.length === 0) {
                        return errorResponse('Missing required field: accountKey', 'bad_request', 400);
                    }
                    const account = await runtime.createManagedAccount({
                        accountKey,
                        label: typeof label === 'string' ? label : undefined,
                        representative: typeof representative === 'string' ? representative : undefined,
                        idempotencyKey: mutationKey,
                    });
                    return json(account, 201);
                }
                else {
                    if (typeof address !== 'string') {
                        return errorResponse('Missing required field for watched account: address', 'bad_request', 400);
                    }
                    const account = await runtime.createWatchedAccount({
                        address,
                        label: typeof label === 'string' ? label : undefined,
                        idempotencyKey: mutationKey,
                    });
                    return json(account, 201);
                }
            }
            catch (err) {
                const handled = handleRaiFlowError(err);
                if (handled)
                    return handled;
                throw err;
            }
        }
        // GET /api/accounts
        if (method === 'GET' && parts.length === 1) {
            const typeParam = url.searchParams.get('type') ?? undefined;
            const filter = typeParam !== undefined
                ? { type: typeParam }
                : undefined;
            const accounts = await runtime.listAccounts(filter);
            return json({ data: accounts });
        }
        if (parts.length >= 2) {
            const accountId = parts[1];
            // GET /api/accounts/:id
            if (method === 'GET' && parts.length === 2) {
                const account = await runtime.getAccount(accountId);
                if (account === undefined) {
                    return errorResponse(`Account not found: ${accountId}`, 'not_found', 404);
                }
                return json(account);
            }
            // PATCH /api/accounts/:id
            if (method === 'PATCH' && parts.length === 2) {
                const mutationKey = idempotencyKey(req);
                if (!mutationKey)
                    return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
                const body = await req.json();
                const patch = {};
                if (typeof body.label === 'string')
                    patch.label = body.label;
                if (typeof body.representative === 'string')
                    patch.representative = body.representative;
                try {
                    const account = await runtime.updateAccount(accountId, patch, mutationKey);
                    return json(account);
                }
                catch (err) {
                    const handled = handleRaiFlowError(err);
                    if (handled)
                        return handled;
                    throw err;
                }
            }
            if (method === 'DELETE' && parts.length === 2) {
                const mutationKey = idempotencyKey(req);
                if (!mutationKey)
                    return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
                try {
                    const removed = await runtime.deleteAccount(accountId, mutationKey);
                    if (removed)
                        accountStateSync?.removeAccount(removed.address);
                    return new Response(null, { status: 204 });
                }
                catch (err) {
                    const handled = handleRaiFlowError(err);
                    if (handled)
                        return handled;
                    throw err;
                }
            }
            // POST /api/accounts/:id/watch
            if (method === 'POST' && parts.length === 3 && parts[2] === 'watch') {
                if (!accountStateSync || !subscriptionManager) {
                    return errorResponse('Streaming not configured', 'bad_request', 400);
                }
                const account = await runtime.getAccount(accountId);
                if (account === undefined) {
                    return errorResponse(`Account not found: ${accountId}`, 'not_found', 404);
                }
                const streamId = req.headers.get('x-raiflow-stream-id');
                if (!streamId) {
                    return errorResponse('Missing X-Raiflow-Stream-Id header', 'bad_request', 400);
                }
                const sseController = subscriptionManager.getConnection(streamId);
                if (!sseController) {
                    return errorResponse('Invalid or expired stream ID', 'bad_request', 400);
                }
                await accountStateSync.addAccount(account.address);
                subscriptionManager.subscribe(account.address, sseController);
                return new Response(null, { status: 204 });
            }
            // DELETE /api/accounts/:id/watch
            if (method === 'DELETE' && parts.length === 3 && parts[2] === 'watch') {
                if (!subscriptionManager) {
                    return errorResponse('Streaming not configured', 'bad_request', 400);
                }
                const account = await runtime.getAccount(accountId);
                if (account === undefined) {
                    return errorResponse(`Account not found: ${accountId}`, 'not_found', 404);
                }
                const streamId = req.headers.get('x-raiflow-stream-id');
                if (!streamId) {
                    return errorResponse('Missing X-Raiflow-Stream-Id header', 'bad_request', 400);
                }
                const sseController = subscriptionManager.getConnection(streamId);
                if (sseController) {
                    subscriptionManager.unsubscribe(account.address, sseController);
                }
                if (!subscriptionManager.hasSubscribers(account.address)) {
                    accountStateSync?.removeAccount(account.address);
                }
                return new Response(null, { status: 204 });
            }
            // POST /api/accounts/:id/sends
            if (method === 'POST' && parts.length === 3 && parts[2] === 'sends') {
                if (runtime.mode === 'non-custodial') {
                    return errorResponse('Sends are not available in non-custodial mode. Use POST /v1/blocks to publish pre-signed blocks.', 'not_implemented', 501);
                }
                const body = await req.json();
                const { destination, amountRaw } = body;
                const mutationKey = idempotencyKey(req);
                if (typeof destination !== 'string' || typeof amountRaw !== 'string' || !mutationKey) {
                    return errorResponse('Missing destination, amountRaw, or Idempotency-Key header', 'bad_request', 400);
                }
                try {
                    const send = await runtime.queueSend({
                        accountId,
                        destination,
                        amountRaw,
                        idempotencyKey: mutationKey,
                    });
                    return json(send, 201);
                }
                catch (err) {
                    const handled = handleRaiFlowError(err);
                    if (handled)
                        return handled;
                    throw err;
                }
            }
            // GET /api/accounts/:id/sends
            if (method === 'GET' && parts.length === 3 && parts[2] === 'sends') {
                const account = await runtime.getAccount(accountId);
                if (account === undefined) {
                    return errorResponse(`Account not found: ${accountId}`, 'not_found', 404);
                }
                const sends = await runtime.listSendsByAccount(accountId);
                return json({ data: sends });
            }
            // GET /api/accounts/:id/receivable
            if (method === 'GET' && parts.length === 3 && parts[2] === 'receivable') {
                const account = await runtime.getAccount(accountId);
                if (account === undefined) {
                    return errorResponse(`Account not found: ${accountId}`, 'not_found', 404);
                }
                const client = runtime.rpcPool?.getClient();
                if (!client)
                    return errorResponse('RPC not configured', 'bad_request', 400);
                try {
                    const receivable = await client.accountsReceivable(account.address);
                    return json({ data: receivable });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : 'RPC error';
                    return errorResponse(message, 'rpc_error', 502);
                }
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Blocks
    // ---------------------------------------------------------------------------
    if (parts[0] === 'blocks' && method === 'POST' && parts.length === 1) {
        const body = await req.json();
        const { block } = body;
        if (typeof block !== 'string') {
            return errorResponse('Missing required field: block (JSON string)', 'bad_request', 400);
        }
        const mutationKey = idempotencyKey(req);
        if (!mutationKey)
            return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
        try {
            const result = await runtime.publishBlock(block, mutationKey);
            return json(result, 201);
        }
        catch (err) {
            const handled = handleRaiFlowError(err);
            if (handled)
                return handled;
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('Block work is less than threshold')) {
                return errorResponse(message, 'insufficient_work', 422);
            }
            throw err;
        }
    }
    // ---------------------------------------------------------------------------
    // Work
    // ---------------------------------------------------------------------------
    if (parts[0] === 'work' && method === 'POST' && parts.length === 1) {
        const body = await req.json();
        const { hash } = body;
        if (typeof hash !== 'string') {
            return errorResponse('Missing required field: hash', 'bad_request', 400);
        }
        const client = runtime.rpcPool?.getClient();
        if (!client)
            return errorResponse('RPC not configured', 'bad_request', 400);
        try {
            const result = await client.workGenerate(hash);
            return json(result);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'RPC error';
            return errorResponse(message, 'rpc_error', 502);
        }
    }
    // ---------------------------------------------------------------------------
    // Sends (global)
    // ---------------------------------------------------------------------------
    if (parts[0] === 'sends' && parts.length === 2) {
        const sendId = parts[1];
        // GET /api/sends/:id
        if (method === 'GET') {
            const send = await runtime.getSend(sendId);
            if (send === undefined) {
                return errorResponse(`Send not found: ${sendId}`, 'not_found', 404);
            }
            return json(send);
        }
    }
    // ---------------------------------------------------------------------------
    // Invoices
    // ---------------------------------------------------------------------------
    if (parts[0] === 'events' && parts[1] === 'stream' && method === 'GET' && parts.length === 2) {
        let cursor = url.searchParams.get('after') ?? undefined;
        let stopped = false;
        let timer;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            start(controller) {
                const pump = async () => {
                    if (stopped)
                        return;
                    try {
                        const page = await runtime.listEvents({ after: cursor, limit: 100 });
                        for (const event of page.data) {
                            controller.enqueue(encoder.encode(`id: ${event.sequence ?? event.id}\ndata: ${JSON.stringify(event)}\n\n`));
                            cursor = event.sequence !== undefined ? String(event.sequence) : event.id;
                        }
                        controller.enqueue(encoder.encode(': keepalive\n\n'));
                    }
                    catch (error) {
                        controller.error(error);
                        stopped = true;
                        return;
                    }
                    timer = setTimeout(() => void pump(), 1_000);
                };
                void pump();
            },
            cancel() {
                stopped = true;
                if (timer !== undefined)
                    clearTimeout(timer);
            },
        });
        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                // Prevent reverse proxies from buffering keepalive frames until the
                // client-side idle timeout closes this long-lived stream.
                'X-Accel-Buffering': 'no',
            },
        });
    }
    if (parts[0] === 'events' && method === 'GET' && parts.length === 1) {
        const after = url.searchParams.get('after') ?? undefined;
        const type = url.searchParams.get('type') ?? undefined;
        const typesParam = url.searchParams.get('types');
        const requestedTypes = typesParam
            ? typesParam.split(',').map((t) => t.trim()).filter(Boolean)
            : null;
        const OPT_IN_EVENT_TYPES = new Set(['receive.confirmed', 'receive.failed']);
        const resourceType = url.searchParams.get('resourceType') ?? undefined;
        const resourceId = url.searchParams.get('resourceId') ?? undefined;
        const limitParam = url.searchParams.get('limit');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
        const result = await runtime.listEvents({
            after,
            type: requestedTypes ? undefined : type,
            resourceType,
            resourceId,
            limit: Number.isFinite(limit) ? limit : undefined,
        });
        const filteredEvents = result.data.filter((event) => {
            if (OPT_IN_EVENT_TYPES.has(event.type) && !requestedTypes?.includes(event.type)) {
                return false;
            }
            if (requestedTypes && !requestedTypes.includes(event.type)) {
                return false;
            }
            return true;
        });
        return json({ data: filteredEvents, nextCursor: result.nextCursor });
    }
    if (parts[0] === 'invoice-accounts') {
        const accountKey = parts[1] ? decodeURIComponent(parts[1]) : undefined;
        if (!accountKey) {
            return errorResponse('accountKey is required', 'bad_request', 400);
        }
        if (method === 'GET' && parts.length === 3 && parts[2] === 'balance') {
            const invoiceKeyParam = url.searchParams.get('invoiceKey');
            const result = await runtime.getInvoiceAccountBalance(accountKey, invoiceKeyParam);
            if (!result)
                return errorResponse('Invoice account not found', 'not_found', 404);
            return json(result);
        }
        if (method === 'GET' && parts.length === 3 && parts[2] === 'aggregated-balance') {
            const result = await runtime.getInvoiceAccountAggregatedBalance(accountKey);
            return json(result);
        }
        if (method === 'GET' && parts.length === 3 && parts[2] === 'invoices') {
            const invoices = await runtime.getInvoicesByAccountKey(accountKey);
            return json({ data: invoices });
        }
    }
    if (parts[0] === 'invoices') {
        // POST /api/invoices
        if (method === 'POST' && parts.length === 1) {
            if (runtime.mode === 'non-custodial') {
                return errorResponse('Invoices are not available in non-custodial mode.', 'not_implemented', 501);
            }
            const body = await req.json();
            const { recipientAccount, expectedAmountRaw, accountKey, invoiceKey, expiresAt, metadata, completionPolicy } = body;
            if (recipientAccount !== undefined) {
                return errorResponse('recipientAccount is deprecated and no longer accepted. Remove it; RaiFlow now derives payAddress per invoice.', 'bad_request', 400);
            }
            if (typeof expectedAmountRaw !== 'string') {
                return errorResponse('Missing required field: expectedAmountRaw', 'bad_request', 400);
            }
            if (typeof accountKey !== 'string' || accountKey.length === 0) {
                return errorResponse('Missing required field: accountKey', 'bad_request', 400);
            }
            const mutationKey = idempotencyKey(req);
            if (!mutationKey)
                return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
            const invoice = await runtime.createInvoice({
                expectedAmountRaw,
                accountKey,
                invoiceKey: typeof invoiceKey === 'string' ? invoiceKey : undefined,
                expiresAt: typeof expiresAt === 'string' ? expiresAt : undefined,
                metadata: typeof metadata === 'object' && metadata !== null
                    ? metadata
                    : undefined,
                completionPolicy: typeof completionPolicy === 'object' && completionPolicy !== null
                    ? completionPolicy
                    : undefined,
            }, mutationKey);
            return json(invoice, 201);
        }
        // GET /api/invoices
        if (method === 'GET' && parts.length === 1) {
            const accountKey = url.searchParams.get('accountKey');
            if (accountKey) {
                const invoices = await runtime.getInvoicesByAccountKey(accountKey);
                return json({ data: invoices });
            }
            const statusParam = url.searchParams.get('status') ?? undefined;
            const filter = statusParam !== undefined
                ? { status: statusParam }
                : undefined;
            const invoices = await runtime.listInvoices(filter);
            return json({ data: invoices });
        }
        // GET /api/invoices/by-key?accountKey=...&invoiceKey=...
        // This is deliberately a singular lookup: application recovery must not
        // list and filter a potentially large invoice history.
        if (method === 'GET' && parts.length === 2 && parts[1] === 'by-key') {
            const accountKey = url.searchParams.get('accountKey');
            const invoiceKey = url.searchParams.get('invoiceKey');
            if (!accountKey)
                return errorResponse('accountKey is required', 'bad_request', 400);
            const invoice = await runtime.getInvoiceByAccountKeyAndInvoiceKey(accountKey, invoiceKey);
            if (!invoice)
                return errorResponse('Invoice not found for accountKey/invoiceKey', 'not_found', 404);
            return json(invoice);
        }
        if (parts.length >= 2) {
            const invoiceId = parts[1];
            // GET /api/invoices/:id
            if (method === 'GET' && parts.length === 2) {
                const invoice = await runtime.getInvoice(invoiceId);
                if (invoice === undefined) {
                    return errorResponse(`Invoice not found: ${invoiceId}`, 'not_found', 404);
                }
                return json(invoice);
            }
            // POST /api/invoices/:id/cancel
            if (method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
                try {
                    const mutationKey = idempotencyKey(req);
                    if (!mutationKey)
                        return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
                    const invoice = await runtime.cancelInvoice(invoiceId, mutationKey);
                    return json(invoice);
                }
                catch (err) {
                    const handled = handleRaiFlowError(err);
                    if (handled)
                        return handled;
                    throw err;
                }
            }
            // GET /api/invoices/:id/payments
            if (method === 'GET' && parts.length === 3 && parts[2] === 'payments') {
                const invoice = await runtime.getInvoice(invoiceId);
                if (invoice === undefined) {
                    return errorResponse(`Invoice not found: ${invoiceId}`, 'not_found', 404);
                }
                const payments = await runtime.getPaymentsByInvoice(invoiceId);
                return json({ data: payments });
            }
            // GET /api/invoices/:id/events
            if (method === 'GET' && parts.length === 3 && parts[2] === 'events') {
                const invoice = await runtime.getInvoice(invoiceId);
                if (invoice === undefined) {
                    return errorResponse(`Invoice not found: ${invoiceId}`, 'not_found', 404);
                }
                const after = url.searchParams.get('after') ?? undefined;
                const events = await runtime.getEventsByInvoice(invoiceId, { after });
                return json({ data: events });
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Webhooks
    // ---------------------------------------------------------------------------
    if (parts[0] === 'webhooks') {
        // POST /api/webhooks
        if (method === 'POST' && parts.length === 1) {
            const body = await req.json();
            const { url: webhookUrl, eventTypes, secret } = body;
            if (typeof webhookUrl !== 'string' || !Array.isArray(eventTypes)) {
                return errorResponse('Missing required fields: url, eventTypes', 'bad_request', 400);
            }
            const createInputRaw = {
                url: webhookUrl,
                eventTypes: eventTypes,
            };
            if (typeof secret === 'string')
                createInputRaw['secret'] = secret;
            const idempotencyKey = req.headers.get('Idempotency-Key') ?? undefined;
            if (!idempotencyKey)
                return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
            const endpoint = await runtime.createWebhookEndpoint(createInputRaw, idempotencyKey);
            return json(endpoint, 201);
        }
        // GET /api/webhooks
        if (method === 'GET' && parts.length === 1) {
            const endpoints = await runtime.webhookEndpointStore.list();
            return json({ data: endpoints });
        }
        // DELETE /api/webhooks/:id
        if (method === 'DELETE' && parts.length === 2) {
            const webhookId = parts[1];
            const idempotencyKey = req.headers.get('Idempotency-Key') ?? undefined;
            if (!idempotencyKey)
                return errorResponse('Idempotency-Key header is required', 'bad_request', 400);
            const deleted = await runtime.deleteWebhookEndpoint(webhookId, idempotencyKey);
            if (!deleted) {
                return errorResponse(`Webhook not found: ${webhookId}`, 'not_found', 404);
            }
            return new Response(null, { status: 204 });
        }
    }
    // No route matched
    return errorResponse('Not found', 'not_found', 404);
}
//# sourceMappingURL=handler.js.map