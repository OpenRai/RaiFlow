// @openrai/runtime — HTTP handler tests

import { describe, it, expect } from 'vitest';
import type { RaiFlowEvent } from '@openrai/model';
import type { WebhookDelivery } from '@openrai/webhook';
import { Runtime } from '../runtime.js';
import { createHandler } from '../handler.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ONE_XNO = '1000000000000000000000000000000';
const TEST_ACCOUNT = 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';

function createTestRuntime() {
  const deliveredEvents: { event: RaiFlowEvent; endpoints: unknown[] }[] = [];
  const fakeDelivery: WebhookDelivery = {
    deliver: async (event, endpoints) => {
      deliveredEvents.push({ event, endpoints });
    },
    shutdown: () => {},
  };
  const runtime = new Runtime({ webhookDelivery: fakeDelivery });
  return { runtime, deliveredEvents };
}

function req(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const init: RequestInit = { method };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  } else if (options.headers) {
    init.headers = options.headers;
  }
  return new Request(`http://localhost${path}`, init);
}

async function parseJson(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with { status: ok }', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('GET', '/health'));

    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({ status: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// POST /invoices
// ---------------------------------------------------------------------------

describe('POST /invoices', () => {
  it('returns 201 with invoice on valid body', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('POST', '/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
    }));

    expect(res.status).toBe(201);
    const body = await parseJson(res) as { status: string; currency: string };
    expect(body.status).toBe('open');
    expect(body.currency).toBe('XNO');
  });

  it('returns 400 when required fields are missing', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('POST', '/invoices', {
      body: { recipientAccount: TEST_ACCOUNT },
    }));

    expect(res.status).toBe(400);
    const body = await parseJson(res) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('returns same invoice on replay with Idempotency-Key header', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const idemKey = 'test-idem-key';

    const res1 = await handler(req('POST', '/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
      headers: { 'Idempotency-Key': idemKey },
    }));
    const res2 = await handler(req('POST', '/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
      headers: { 'Idempotency-Key': idemKey },
    }));

    const inv1 = await parseJson(res1) as { id: string };
    const inv2 = await parseJson(res2) as { id: string };

    expect(inv1.id).toBe(inv2.id);
  });

  it('accepts completionPolicy in request body', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('POST', '/invoices', {
      body: {
        recipientAccount: TEST_ACCOUNT,
        expectedAmountRaw: ONE_XNO,
        completionPolicy: { type: 'exact' },
      },
    }));

    expect(res.status).toBe(201);
    const body = await parseJson(res) as { completionPolicy: { type: string } };
    expect(body.completionPolicy).toEqual({ type: 'exact' });
  });

  it('defaults completionPolicy to at_least when not provided', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('POST', '/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
    }));

    expect(res.status).toBe(201);
    const body = await parseJson(res) as { completionPolicy: { type: string } };
    expect(body.completionPolicy).toEqual({ type: 'at_least' });
  });
});

// ---------------------------------------------------------------------------
// GET /invoices
// ---------------------------------------------------------------------------

describe('GET /invoices', () => {
  it('returns list of invoices', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    await runtime.createInvoice({ recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO });
    await runtime.createInvoice({ recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO });

    const res = await handler(req('GET', '/invoices'));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(2);
  });

  it('filters by status=open', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const inv = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT,
      expectedAmountRaw: ONE_XNO,
    });
    await runtime.createInvoice({ recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO });
    await runtime.cancelInvoice(inv.id);

    const res = await handler(req('GET', '/invoices?status=open'));

    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /invoices/:id
// ---------------------------------------------------------------------------

describe('GET /invoices/:id', () => {
  it('returns the invoice', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT,
      expectedAmountRaw: ONE_XNO,
    });

    const res = await handler(req('GET', `/invoices/${invoice.id}`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { id: string };
    expect(body.id).toBe(invoice.id);
  });

  it('returns 404 for non-existent invoice', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('GET', '/invoices/does-not-exist'));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /invoices/:id/cancel
// ---------------------------------------------------------------------------

describe('POST /invoices/:id/cancel', () => {
  it('returns updated invoice with status canceled', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT,
      expectedAmountRaw: ONE_XNO,
    });

    const res = await handler(req('POST', `/invoices/${invoice.id}/cancel`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { status: string };
    expect(body.status).toBe('canceled');
  });

  it('returns 409 when canceling a completed invoice', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT,
      expectedAmountRaw: ONE_XNO,
    });

    // Complete the invoice
    await runtime.handleConfirmedBlock({
      blockHash: 'hash-complete',
      senderAccount: 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
      recipientAccount: TEST_ACCOUNT,
      amountRaw: ONE_XNO,
      confirmedAt: new Date().toISOString(),
    });

    const res = await handler(req('POST', `/invoices/${invoice.id}/cancel`));

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /invoices/:id/payments
// ---------------------------------------------------------------------------

describe('GET /invoices/:id/payments', () => {
  it('returns payments array', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock({
      blockHash: 'hash-pay-1',
      senderAccount: 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
      recipientAccount: TEST_ACCOUNT,
      amountRaw: ONE_XNO,
      confirmedAt: new Date().toISOString(),
    });

    const res = await handler(req('GET', `/invoices/${invoice.id}/payments`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /invoices/:id/events
// ---------------------------------------------------------------------------

describe('GET /invoices/:id/events', () => {
  it('returns events array', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT,
      expectedAmountRaw: ONE_XNO,
    });

    const res = await handler(req('GET', `/invoices/${invoice.id}/events`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    // At least the invoice.created event
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('supports after cursor parameter', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT,
      expectedAmountRaw: ONE_XNO,
    });

    const eventsRes = await handler(req('GET', `/invoices/${invoice.id}/events`));
    const eventsBody = await parseJson(eventsRes) as { data: { id: string }[] };
    const firstEventId = eventsBody.data[0]!.id;

    const res = await handler(req('GET', `/invoices/${invoice.id}/events?after=${firstEventId}`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks
// ---------------------------------------------------------------------------

describe('POST /webhooks', () => {
  it('creates endpoint with generated secret', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('POST', '/webhooks', {
      body: {
        url: 'https://example.com/hook',
        eventTypes: ['invoice.created'],
      },
    }));

    expect(res.status).toBe(201);
    const body = await parseJson(res) as { id: string; secret: string; url: string };
    expect(body.id).toBeDefined();
    expect(body.secret).toBeDefined();
    expect(body.url).toBe('https://example.com/hook');
  });

  it('returns 400 when required fields are missing', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('POST', '/webhooks', {
      body: { url: 'https://example.com/hook' }, // missing eventTypes
    }));

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /webhooks
// ---------------------------------------------------------------------------

describe('GET /webhooks', () => {
  it('lists endpoints', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    await runtime.webhookEndpointStore.create({
      url: 'https://example.com/hook',
      eventTypes: ['invoice.created'],
      secret: 'test-secret',
    });

    const res = await handler(req('GET', '/webhooks'));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE /webhooks/:id
// ---------------------------------------------------------------------------

describe('DELETE /webhooks/:id', () => {
  it('returns 204 on successful delete', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const endpoint = await runtime.webhookEndpointStore.create({
      url: 'https://example.com/hook',
      eventTypes: ['invoice.created'],
      secret: 'test-secret',
    });

    const res = await handler(req('DELETE', `/webhooks/${endpoint.id}`));

    expect(res.status).toBe(204);
  });

  it('returns 404 for non-existent webhook', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('DELETE', '/webhooks/non-existent'));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Unknown route
// ---------------------------------------------------------------------------

describe('Unknown route', () => {
  it('returns 404 for unknown path', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime);

    const res = await handler(req('GET', '/this-does-not-exist'));

    expect(res.status).toBe(404);
  });
});
