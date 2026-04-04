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
