// @openrai/runtime — Framework-agnostic HTTP handler

import type { InvoiceStatus, RaiFlowEventType } from '@openrai/model';
import { RaiFlowError, isErrorWithCode } from '@openrai/model';
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
export function createHandler(runtime: Runtime): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      return await route(req, runtime);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return errorResponse(message, 'internal_error', 500);
    }
  };
}

async function route(req: Request, runtime: Runtime): Promise<Response> {
  const url = new URL(req.url, 'http://localhost');

  // Strip leading slash and split into parts, ignoring empty segments
  const parts = url.pathname.replace(/^\//, '').split('/').filter(Boolean);

  const method = req.method.toUpperCase();

  // GET /health
  if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
    return json({ status: 'ok' });
  }

  // GET /
  if (method === 'GET' && parts.length === 0) {
    const html = await renderDashboard(runtime, {
      view: url.searchParams.get('view') ?? undefined,
      config: (globalThis as { __RAIFLOW_CONFIG__?: unknown }).__RAIFLOW_CONFIG__ as import('@openrai/config').RaiFlowConfig | undefined,
      metrics: (globalThis as { __RAIFLOW_METRICS__?: unknown }).__RAIFLOW_METRICS__ as import('./monitoring.js').RuntimeMetricsSnapshot | undefined,
    });
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  if (parts[0] === 'accounts') {
    // POST /accounts
    if (method === 'POST' && parts.length === 1) {
      const body = await req.json() as Record<string, unknown>;
      const { type, label, representative, address, idempotencyKey } = body;

      if (type !== 'managed' && type !== 'watched') {
        return errorResponse('Missing or invalid field: type (must be "managed" or "watched")', 'bad_request', 400);
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
        if (isErrorWithCode(err)) {
          if (err.code === 'bad_request') {
            return errorResponse(err.message, 'bad_request', 400);
          }
          if (err.code === 'conflict') {
            return errorResponse(err.message, 'conflict', 409);
          }
        }
        throw err;
      }
    }

    // GET /accounts
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

      // GET /accounts/:id
      if (method === 'GET' && parts.length === 2) {
        const account = await runtime.getAccount(accountId);
        if (account === undefined) {
          return errorResponse(`Account not found: ${accountId}`, 'not_found', 404);
        }
        return json(account);
      }

      // PATCH /accounts/:id
      if (method === 'PATCH' && parts.length === 2) {
        const body = await req.json() as Record<string, unknown>;
        const patch: { label?: string; representative?: string } = {};
        if (typeof body.label === 'string') patch.label = body.label;
        if (typeof body.representative === 'string') patch.representative = body.representative;

        try {
          const account = await runtime.updateAccount(accountId, patch);
          return json(account);
        } catch (err) {
          if (isErrorWithCode(err)) {
            if (err.code === 'not_found') {
              return errorResponse(err.message, 'not_found', 404);
            }
            if (err.code === 'bad_request') {
              return errorResponse(err.message, 'bad_request', 400);
            }
          }
          throw err;
        }
      }

      // POST /accounts/:id/sends
      if (method === 'POST' && parts.length === 3 && parts[2] === 'sends') {
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
          if (isErrorWithCode(err)) {
            if (err.code === 'not_found') {
              return errorResponse(err.message, 'not_found', 404);
            }
            if (err.code === 'bad_request') {
              return errorResponse(err.message, 'bad_request', 400);
            }
            if (err.code === 'conflict') {
              return errorResponse(err.message, 'conflict', 409);
            }
          }
          throw err;
        }
      }

      // GET /accounts/:id/sends
      if (method === 'GET' && parts.length === 3 && parts[2] === 'sends') {
        const account = await runtime.getAccount(accountId);
        if (account === undefined) {
          return errorResponse(`Account not found: ${accountId}`, 'not_found', 404);
        }
        const sends = await runtime.listSendsByAccount(accountId);
        return json({ data: sends });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Sends (global)
  // ---------------------------------------------------------------------------

  if (parts[0] === 'sends' && parts.length === 2) {
    const sendId = parts[1]!;

    // GET /sends/:id
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
    // POST /invoices
    if (method === 'POST' && parts.length === 1) {
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

    // GET /invoices
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

      // GET /invoices/:id
      if (method === 'GET' && parts.length === 2) {
        const invoice = await runtime.getInvoice(invoiceId);
        if (invoice === undefined) {
          return errorResponse(`Invoice not found: ${invoiceId}`, 'not_found', 404);
        }
        return json(invoice);
      }

      // POST /invoices/:id/cancel
      if (method === 'POST' && parts.length === 3 && parts[2] === 'cancel') {
        try {
          const invoice = await runtime.cancelInvoice(invoiceId);
          return json(invoice);
        } catch (err) {
          if (isErrorWithCode(err)) {
            if (err.code === 'not_found') {
              return errorResponse(err.message, 'not_found', 404);
            }
            if (err.code === 'conflict') {
              return errorResponse(err.message, 'conflict', 409);
            }
          }
          throw err;
        }
      }

      // GET /invoices/:id/payments
      if (method === 'GET' && parts.length === 3 && parts[2] === 'payments') {
        const invoice = await runtime.getInvoice(invoiceId);
        if (invoice === undefined) {
          return errorResponse(`Invoice not found: ${invoiceId}`, 'not_found', 404);
        }
        const payments = await runtime.getPaymentsByInvoice(invoiceId);
        return json({ data: payments });
      }

      // GET /invoices/:id/events
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
    // POST /webhooks
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
      // The create() method accepts secret as optional (store auto-generates it).
      // We build a loose object and cast via unknown to avoid the intersection type issue.
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

    // GET /webhooks
    if (method === 'GET' && parts.length === 1) {
      const endpoints = await runtime.webhookEndpointStore.list();
      return json({ data: endpoints });
    }

    // DELETE /webhooks/:id
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
