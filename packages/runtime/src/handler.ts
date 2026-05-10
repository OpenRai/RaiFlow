// @openrai/runtime — Framework-agnostic HTTP handler

import type { InvoiceStatus, RaiFlowEventType } from '@openrai/model';
import { RaiFlowError, isErrorWithCode } from '@openrai/model';
import { type RaiFlowConfig } from '@openrai/config';
import { Runtime } from './runtime.js';
import { renderDashboard } from './dashboard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(
  message: string,
  code: string,
  status: number,
): Response {
  return json({ error: { message, code } }, status);
}

interface ParsedRoute {
  url: URL;
  parts: string[];
  method: string;
}

function parseRoute(req: Request): ParsedRoute {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
  const method = req.method.toUpperCase();
  return { url, parts, method };
}

function handleRaiFlowError(err: unknown): Response | undefined {
  if (isErrorWithCode(err)) {
    const statusMap: Record<string, number> = {
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
function getPathSegment(
  parts: string[],
  index: number,
): string | undefined {
  return parts[index];
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
function checkAuth(req: Request, config: RaiFlowConfig): Response | undefined {
  const apiKey = config.daemon.apiKey;

  const { parts, method } = parseRoute(req);

  // Exempt wayfinder (GET /)
  if (method === 'GET' && parts.length === 0) {
    return undefined;
  }

  // Exempt health check (GET /api/health)
  if (method === 'GET' && parts.length === 2 && parts[0] === 'api' && parts[1] === 'health') {
    return undefined;
  }

  // Exempt dashboard (GET /dashboard) if configured
  if (config.daemon.enableDashboardAuth === false && method === 'GET' && parts.length === 1 && parts[0] === 'dashboard') {
    return undefined;
  }

  if (!apiKey) return undefined;

  const authHeader = req.headers.get('authorization') ?? '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== apiKey) {
    return errorResponse('Unauthorized', 'unauthorized', 401);
  }

  return undefined;
}

export function createHandler(runtime: Runtime, config: RaiFlowConfig, version?: string): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const authFailure = checkAuth(req, config);
      if (authFailure) return authFailure;

      return await route(req, runtime, config, version);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return errorResponse(message, 'internal_error', 500);
    }
  };
}

async function route(req: Request, runtime: Runtime, config: RaiFlowConfig, version?: string): Promise<Response> {
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
      <a href="/api/health">API Health</a>
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
      metrics: (globalThis as { __RAIFLOW_METRICS__?: unknown }).__RAIFLOW_METRICS__ as import('./monitoring.js').RuntimeMetricsSnapshot | undefined,
      showInternal: url.searchParams.get('showInternal') === 'true',
      version,
    });
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // /api/* — API routes (strip 'api' prefix)
  if (parts[0] === 'api') {
    return routeApi(parts.slice(1), url, method, req, runtime);
  }

  // No route matched
  return errorResponse('Not found', 'not_found', 404);
}

async function routeApi(parts: string[], url: URL, method: string, req: Request, runtime: Runtime): Promise<Response> {
  // GET /api/health
  if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
    return json({ status: 'ok' });
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  if (parts[0] === 'accounts') {
    // POST /api/accounts
    if (method === 'POST' && parts.length === 1) {
      const body = await req.json() as Record<string, unknown>;
      const { type, label, representative, address, idempotencyKey } = body;

      if (type !== 'managed' && type !== 'watched') {
        return errorResponse('Missing or invalid field: type (must be "managed" or "watched")', 'bad_request', 400);
      }

      if (type === 'managed' && runtime.mode === 'non-custodial') {
        return errorResponse(
          'Managed accounts are not available in non-custodial mode. Use type "watched" instead.',
          'not_implemented',
          501,
        );
      }

      try {
        if (type === 'managed') {
          const account = await runtime.createManagedAccount({
            label: typeof label === 'string' ? label : undefined,
            representative: typeof representative === 'string' ? representative : undefined,
            idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
          });
          return json(account, 201);
        } else {
          if (typeof address !== 'string') {
            return errorResponse('Missing required field for watched account: address', 'bad_request', 400);
          }
          const account = await runtime.createWatchedAccount({
            address,
            label: typeof label === 'string' ? label : undefined,
          });
          return json(account, 201);
        }
      } catch (err) {
        const handled = handleRaiFlowError(err);
        if (handled) return handled;
        throw err;
      }
    }

    // GET /api/accounts
    if (method === 'GET' && parts.length === 1) {
      const typeParam = url.searchParams.get('type') ?? undefined;
      const filter = typeParam !== undefined
        ? { type: typeParam as 'managed' | 'watched' }
        : undefined;
      const accounts = await runtime.listAccounts(filter);
      return json({ data: accounts });
    }

    if (parts.length >= 2) {
      const accountId = parts[1]!;

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
        const body = await req.json() as Record<string, unknown>;
        const patch: { label?: string; representative?: string } = {};
        if (typeof body.label === 'string') patch.label = body.label;
        if (typeof body.representative === 'string') patch.representative = body.representative;

        try {
          const account = await runtime.updateAccount(accountId, patch);
          return json(account);
        } catch (err) {
          const handled = handleRaiFlowError(err);
          if (handled) return handled;
          throw err;
        }
      }

      // POST /api/accounts/:id/sends
      if (method === 'POST' && parts.length === 3 && parts[2] === 'sends') {
        if (runtime.mode === 'non-custodial') {
          return errorResponse(
            'Sends are not available in non-custodial mode. Use POST /api/blocks to publish pre-signed blocks.',
            'not_implemented',
            501,
          );
        }

        const body = await req.json() as Record<string, unknown>;
        const { destination, amountRaw, idempotencyKey } = body;

        if (typeof destination !== 'string' || typeof amountRaw !== 'string' || typeof idempotencyKey !== 'string') {
          return errorResponse(
            'Missing required fields: destination, amountRaw, idempotencyKey',
            'bad_request',
            400,
          );
        }

        try {
          const send = await runtime.queueSend({
            accountId,
            destination,
            amountRaw,
            idempotencyKey,
          });
          return json(send, 201);
        } catch (err) {
          const handled = handleRaiFlowError(err);
          if (handled) return handled;
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
        if (!client) return errorResponse('RPC not configured', 'bad_request', 400);
        try {
          const receivable = await client.accountsReceivable(account.address);
          return json({ data: receivable });
        } catch (err) {
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
    const body = await req.json() as Record<string, unknown>;
    const { block } = body;
    if (typeof block !== 'string') {
      return errorResponse('Missing required field: block (JSON string)', 'bad_request', 400);
    }
    const client = runtime.rpcPool?.getClient();
    if (!client) return errorResponse('RPC not configured', 'bad_request', 400);
    try {
      const result = await client.process(block);
      return json(result, 201);
    } catch (err) {
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
    const body = await req.json() as Record<string, unknown>;
    const { hash, difficulty, blockType } = body;
    if (typeof hash !== 'string') {
      return errorResponse('Missing required field: hash', 'bad_request', 400);
    }
    const client = runtime.rpcPool?.getClient();
    if (!client) return errorResponse('RPC not configured', 'bad_request', 400);
    const result = await client.workGenerate(
      hash,
      typeof difficulty === 'string' ? difficulty : undefined,
      blockType === 'receive' ? 'receive' : undefined,
    );
    return json(result);
  }

  // ---------------------------------------------------------------------------
  // Sends (global)
  // ---------------------------------------------------------------------------

  if (parts[0] === 'sends' && parts.length === 2) {
    const sendId = parts[1]!;

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

  if (parts[0] === 'invoices') {
    // POST /api/invoices
    if (method === 'POST' && parts.length === 1) {
      if (runtime.mode === 'non-custodial') {
        return errorResponse(
          'Invoices are not available in non-custodial mode.',
          'not_implemented',
          501,
        );
      }

      const body = await req.json() as Record<string, unknown>;
      const { recipientAccount, expectedAmountRaw, expiresAt, metadata, completionPolicy } = body;

      if (typeof recipientAccount !== 'string' || typeof expectedAmountRaw !== 'string') {
        return errorResponse(
          'Missing required fields: recipientAccount, expectedAmountRaw',
          'bad_request',
          400,
        );
      }

      const idempotencyKey = req.headers.get('Idempotency-Key') ?? undefined;

      const invoice = await runtime.createInvoice(
        {
          recipientAccount,
          expectedAmountRaw,
          expiresAt: typeof expiresAt === 'string' ? expiresAt : undefined,
          metadata: typeof metadata === 'object' && metadata !== null
            ? (metadata as Record<string, unknown>)
            : undefined,
          completionPolicy: typeof completionPolicy === 'object' && completionPolicy !== null
            ? (completionPolicy as { type: 'exact' | 'at_least' })
            : undefined,
        },
        idempotencyKey,
      );

      return json(invoice, 201);
    }

    // GET /api/invoices
    if (method === 'GET' && parts.length === 1) {
      const statusParam = url.searchParams.get('status') ?? undefined;
      const filter = statusParam !== undefined
        ? { status: statusParam as InvoiceStatus }
        : undefined;
      const invoices = await runtime.listInvoices(filter);
      return json({ data: invoices });
    }

    if (parts.length >= 2) {
      const invoiceId = parts[1]!;

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
          const invoice = await runtime.cancelInvoice(invoiceId);
          return json(invoice);
        } catch (err) {
          const handled = handleRaiFlowError(err);
          if (handled) return handled;
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
      const body = await req.json() as Record<string, unknown>;
      const { url: webhookUrl, eventTypes, secret } = body;

      if (typeof webhookUrl !== 'string' || !Array.isArray(eventTypes)) {
        return errorResponse(
          'Missing required fields: url, eventTypes',
          'bad_request',
          400,
        );
      }

      type CreateEndpointInput = Parameters<typeof runtime.webhookEndpointStore.create>[0];
      const createInputRaw: Record<string, unknown> = {
        url: webhookUrl,
        eventTypes: eventTypes as RaiFlowEventType[],
      };
      if (typeof secret === 'string') createInputRaw['secret'] = secret;
      const endpoint = await runtime.webhookEndpointStore.create(
        createInputRaw as unknown as CreateEndpointInput,
      );

      return json(endpoint, 201);
    }

    // GET /api/webhooks
    if (method === 'GET' && parts.length === 1) {
      const endpoints = await runtime.webhookEndpointStore.list();
      return json({ data: endpoints });
    }

    // DELETE /api/webhooks/:id
    if (method === 'DELETE' && parts.length === 2) {
      const webhookId = parts[1]!;
      const deleted = await runtime.webhookEndpointStore.delete(webhookId);
      if (!deleted) {
        return errorResponse(`Webhook not found: ${webhookId}`, 'not_found', 404);
      }
      return new Response(null, { status: 204 });
    }
  }

  // No route matched
  return errorResponse('Not found', 'not_found', 404);
}
