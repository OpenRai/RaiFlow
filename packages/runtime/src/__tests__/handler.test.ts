// @openrai/runtime — HTTP handler tests

import { describe, it, expect, vi } from 'vitest';
import { Runtime } from '../runtime.js';
import { createHandler } from '../handler.js';
import { AccountStateSync } from '../account-state-sync.js';
import { SubscriptionManager } from '../subscription-manager.js';
import { createTestConfig, createTestRuntime, req, parseJson, ONE_XNO, TEST_ACCOUNT, createTestInvoice, createHandlerWithRuntime, createHandlerWithInvoice, createMockRpcClient } from './helpers.js';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  it('allows all requests when apiKey is not provided', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: undefined });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/api/invoices'));
    expect(res.status).toBe(200);
  });

  it('exempts GET /api/health from auth', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key' });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/api/health'));
    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({ status: 'ok' });
  });

  it('exempts GET / (wayfinder) from auth', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key' });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RaiFlow');
    expect(html).toContain('/dashboard');
    expect(html).toContain('/api/health');
  });

  it('returns 401 for missing Authorization header when apiKey is set', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key' });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/api/invoices'));
    expect(res.status).toBe(401);
    const body = await parseJson(res) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 for invalid Bearer token', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key' });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/api/invoices', {
      headers: { Authorization: 'Bearer wrong-key' },
    }));
    expect(res.status).toBe(401);
    const body = await parseJson(res) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('allows authenticated requests with correct Bearer token', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key' });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/api/invoices', {
      headers: { Authorization: 'Bearer secret-key' },
    }));
    expect(res.status).toBe(200);
  });

  it('protects dashboard route when apiKey is set', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key' });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/dashboard'));
    expect(res.status).toBe(401);
  });

  it('allows dashboard route when apiKey is set but dashboard auth is disabled', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key', enableDashboardAuth: false });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/dashboard'));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Wayfinder (GET /)
// ---------------------------------------------------------------------------

describe('GET / (wayfinder)', () => {
  it('returns static HTML with links to /dashboard and /api/health', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('GET', '/'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RaiFlow');
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain('href="/api/health"');
  });
});

// ---------------------------------------------------------------------------
// Dashboard (GET /dashboard)
// ---------------------------------------------------------------------------

describe('GET /dashboard', () => {
  it('returns dashboard HTML', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig({ apiKey: undefined }));

    const res = await handler(req('GET', '/dashboard'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('RaiFlow Runtime Dashboard');
    expect(html).toContain('href="/dashboard?view=config"');
  });

  it('renders config view with ?view=config', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: undefined });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/dashboard?view=config'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Effective Non-Secret Configuration');
  });

  it('renders upstream RPC pill on dashboard', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: undefined });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/dashboard'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('Upstream RPC');
    expect(html).toContain('https://rpc.nano.to/');
    expect(html).toContain('upstream-led');
  });
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

describe('GET /api/health', () => {
  it('returns 200 with { status: ok }', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('GET', '/api/health'));

    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({ status: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/version
// ---------------------------------------------------------------------------

describe('GET /api/version', () => {
  it('returns 200 with { version: dev } when no version arg is passed', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('GET', '/api/version'));

    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({ version: 'dev' });
  });

  it('returns the passed version string', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig(), 'v1.2.3-test');

    const res = await handler(req('GET', '/api/version'));

    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({ version: 'v1.2.3-test' });
  });

  it('is exempt from auth', async () => {
    const { runtime } = createTestRuntime();
    const config = createTestConfig({ apiKey: 'secret-key' });
    const handler = createHandler(runtime, config);

    const res = await handler(req('GET', '/api/version'));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/invoices
// ---------------------------------------------------------------------------

describe('POST /api/invoices', () => {
  it('returns 201 with invoice on valid body', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('POST', '/api/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
    }));

    expect(res.status).toBe(201);
    const body = await parseJson(res) as { status: string; currency: string };
    expect(body.status).toBe('open');
    expect(body.currency).toBe('XNO');
  });

  it('returns 400 when required fields are missing', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('POST', '/api/invoices', {
      body: { recipientAccount: TEST_ACCOUNT },
    }));

    expect(res.status).toBe(400);
    const body = await parseJson(res) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('returns same invoice on replay with Idempotency-Key header', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const idemKey = 'test-idem-key';

    const res1 = await handler(req('POST', '/api/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
      headers: { 'Idempotency-Key': idemKey },
    }));
    const res2 = await handler(req('POST', '/api/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
      headers: { 'Idempotency-Key': idemKey },
    }));

    const inv1 = await parseJson(res1) as { id: string };
    const inv2 = await parseJson(res2) as { id: string };

    expect(inv1.id).toBe(inv2.id);
  });

  it('accepts completionPolicy in request body', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('POST', '/api/invoices', {
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
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const res = await handler(req('POST', '/api/invoices', {
      body: { recipientAccount: TEST_ACCOUNT, expectedAmountRaw: ONE_XNO },
    }));

    expect(res.status).toBe(201);
    const body = await parseJson(res) as { completionPolicy: { type: string } };
    expect(body.completionPolicy).toEqual({ type: 'at_least' });
  });
});

describe('GET /api/invoices', () => {
  it('returns list of invoices', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    await createTestInvoice(runtime);
    await createTestInvoice(runtime);

    const res = await handler(req('GET', '/api/invoices'));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(2);
  });

  it('filters by status=open', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const inv = await createTestInvoice(runtime);
    await createTestInvoice(runtime);
    await runtime.cancelInvoice(inv.id);

    const res = await handler(req('GET', '/api/invoices?status=open'));

    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/:id
// ---------------------------------------------------------------------------

describe('GET /api/invoices/:id', () => {
  it('returns the invoice', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const invoice = await createTestInvoice(runtime);

    const res = await handler(req('GET', `/api/invoices/${invoice.id}`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { id: string };
    expect(body.id).toBe(invoice.id);
  });

  it('returns 404 for non-existent invoice', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const res = await handler(req('GET', '/api/invoices/does-not-exist'));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/invoices/:id/cancel
// ---------------------------------------------------------------------------

describe('POST /api/invoices/:id/cancel', () => {
  it('returns updated invoice with status canceled', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const invoice = await createTestInvoice(runtime);

    const res = await handler(req('POST', `/api/invoices/${invoice.id}/cancel`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { status: string };
    expect(body.status).toBe('canceled');
  });

  it('returns 409 when canceling a completed invoice', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const invoice = await createTestInvoice(runtime);

    await runtime.handleConfirmedBlock({
      blockHash: 'hash-complete',
      senderAccount: 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
      recipientAccount: TEST_ACCOUNT,
      amountRaw: ONE_XNO,
      confirmedAt: new Date().toISOString(),
    });

    const res = await handler(req('POST', `/api/invoices/${invoice.id}/cancel`));

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/:id/payments
// ---------------------------------------------------------------------------

describe('GET /api/invoices/:id/payments', () => {
  it('returns payments array', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const invoice = await createTestInvoice(runtime);

    await runtime.handleConfirmedBlock({
      blockHash: 'hash-pay-1',
      senderAccount: 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
      recipientAccount: TEST_ACCOUNT,
      amountRaw: ONE_XNO,
      confirmedAt: new Date().toISOString(),
    });

    const res = await handler(req('GET', `/api/invoices/${invoice.id}/payments`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/:id/events
// ---------------------------------------------------------------------------

describe('GET /api/invoices/:id/events', () => {
  it('returns events array', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const invoice = await createTestInvoice(runtime);

    const res = await handler(req('GET', `/api/invoices/${invoice.id}/events`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    // At least the invoice.created event
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('supports after cursor parameter', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    const invoice = await createTestInvoice(runtime);

    const eventsRes = await handler(req('GET', `/api/invoices/${invoice.id}/events`));
    const eventsBody = await parseJson(eventsRes) as { data: { id: string }[] };
    const firstEventId = eventsBody.data[0]!.id;

    const res = await handler(req('GET', `/api/invoices/${invoice.id}/events?after=${firstEventId}`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/webhooks
// ---------------------------------------------------------------------------

describe('POST /api/webhooks', () => {
  it('creates endpoint with generated secret', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('POST', '/api/webhooks', {
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
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('POST', '/api/webhooks', {
      body: { url: 'https://example.com/hook' }, // missing eventTypes
    }));

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/webhooks
// ---------------------------------------------------------------------------

describe('GET /api/webhooks', () => {
  it('lists endpoints', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    await runtime.webhookEndpointStore.create({
      url: 'https://example.com/hook',
      eventTypes: ['invoice.created'],
      secret: 'test-secret',
    });

    const res = await handler(req('GET', '/api/webhooks'));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/webhooks/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/webhooks/:id', () => {
  it('returns 204 on successful delete', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const endpoint = await runtime.webhookEndpointStore.create({
      url: 'https://example.com/hook',
      eventTypes: ['invoice.created'],
      secret: 'test-secret',
    });

    const res = await handler(req('DELETE', `/api/webhooks/${endpoint.id}`));

    expect(res.status).toBe(204);
  });

  it('returns 404 for non-existent webhook', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('DELETE', '/api/webhooks/non-existent'));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/blocks
// ---------------------------------------------------------------------------

describe('POST /api/blocks', () => {
  it('returns 422 with insufficient_work code when process throws work error', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    (runtime as any).rpcPool = {
      getClient: () => createMockRpcClient({ processError: new Error('Block work is less than threshold') }),
    };

    const blockJson = JSON.stringify({ type: 'send', hash: 'abc123' });
    const res = await handler(req('POST', '/api/blocks', { body: { block: blockJson } }));

    expect(res.status).toBe(422);
    const body = await parseJson(res) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('insufficient_work');
  });

  it('re-throws non-work errors as 500', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    (runtime as any).rpcPool = {
      getClient: () => createMockRpcClient({ processError: new Error('Fork') }),
    };

    const blockJson = JSON.stringify({ type: 'send', hash: 'abc123' });
    const res = await handler(req('POST', '/api/blocks', { body: { block: blockJson } }));

    expect(res.status).toBe(500);
    const body = await parseJson(res) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
  });
});

// ---------------------------------------------------------------------------
// GET /api/accounts/:id/receivable
// ---------------------------------------------------------------------------

describe('GET /api/accounts/:id/receivable', () => {
  const FAKE_ACCOUNT_ID = 'e0b330c7-6505-4130-97ea-ecfac3621934';
  const FAKE_ADDRESS = 'nano_3testing123456789abcdefghijklmnopqrstuvwxyz0123456789abcdef';

  function setupReceivableTest(rpcMock: ReturnType<typeof createMockRpcClient>) {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    vi.spyOn(runtime, 'getAccount').mockResolvedValue({
      id: FAKE_ACCOUNT_ID,
      type: 'watched',
      address: FAKE_ADDRESS,
      label: null,
      balanceRaw: '0',
      pendingRaw: '0',
      frontier: null,
      representative: null,
      derivationIndex: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    (runtime as any).rpcPool = {
      getClient: () => rpcMock,
    };

    return { handler, runtime };
  }

  it('returns 502 (not 500) when RPC client throws Account not found', async () => {
    // In production, the rpc layer catches "Account not found" and returns [].
    // But if ANY error still propagates from the rpc client, the handler must
    // catch it and return 502 — never let it bubble to a 500.
    const rpcMock = createMockRpcClient({
      accountsReceivable: vi.fn().mockRejectedValue(new Error('Account not found')),
    });
    const { handler } = setupReceivableTest(rpcMock);

    const res = await handler(req('GET', `/api/accounts/${FAKE_ACCOUNT_ID}/receivable`));

    expect(res.status).toBe(502);
    const body = await parseJson(res) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rpc_error');
    expect(body.error.message).toBe('Account not found');
  });

  it('returns 200 with receivable data on success', async () => {
    const receivableData = [
      { hash: 'block_hash_1', amount: '1000000000000000000000000000000', sender: 'nano_1sender' },
    ];
    const rpcMock = createMockRpcClient({
      accountsReceivable: vi.fn().mockResolvedValue(receivableData),
    });
    const { handler } = setupReceivableTest(rpcMock);

    const res = await handler(req('GET', `/api/accounts/${FAKE_ACCOUNT_ID}/receivable`));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { data: unknown[] };
    expect(body.data).toEqual(receivableData);
  });

  it('returns 502 when RPC fails with a network/infrastructure error', async () => {
    const rpcMock = createMockRpcClient({
      accountsReceivable: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    const { handler } = setupReceivableTest(rpcMock);

    const res = await handler(req('GET', `/api/accounts/${FAKE_ACCOUNT_ID}/receivable`));

    // Network errors should be 502 Bad Gateway, not 500 Internal Server Error
    expect(res.status).toBe(502);
    const body = await parseJson(res) as { error: { code: string } };
    expect(body.error.code).toBe('rpc_error');
  });

  it('returns 404 when account does not exist in RaiFlow', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    // Don't mock getAccount — let it return undefined naturally
    const res = await handler(req('GET', `/api/accounts/non-existent-id/receivable`));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/work
// ---------------------------------------------------------------------------

describe('POST /api/work', () => {
  it('returns 502 (not 500) when RPC fails with "All endpoints exhausted"', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    (runtime as any).rpcPool = {
      getClient: () => createMockRpcClient({
        workGenerate: vi.fn().mockRejectedValue(new Error('All endpoints exhausted')),
      }),
    };

    const res = await handler(req('POST', '/api/work', { body: { hash: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890' } }));

    expect(res.status).toBe(502);
    const body = await parseJson(res) as { error: { code: string } };
    expect(body.error.code).toBe('rpc_error');
  });

  it('returns 200 with work nonce on success', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandlerWithRuntime(runtime, createTestConfig());

    (runtime as any).rpcPool = {
      getClient: () => createMockRpcClient({
        workGenerate: vi.fn().mockResolvedValue({ work: 'nonce123' }),
      }),
    };

    const res = await handler(req('POST', '/api/work', { body: { hash: 'ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890' } }));

    expect(res.status).toBe(200);
    const body = await parseJson(res) as { work: string };
    expect(body.work).toBe('nonce123');
  });
});

// ---------------------------------------------------------------------------
// Unknown route
// ---------------------------------------------------------------------------

describe('Unknown route', () => {
  it('returns 404 for unknown path', async () => {
    const { runtime } = createTestRuntime();
    const handler = createHandler(runtime, createTestConfig());

    const res = await handler(req('GET', '/this-does-not-exist'));

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SSE & Watch endpoints
// ---------------------------------------------------------------------------

describe('SSE stream', () => {
  it('returns SSE response with stream ID header', async () => {
    const { runtime } = createTestRuntime();
    const subMgr = new SubscriptionManager();
    const handler = createHandler(runtime, createTestConfig(), undefined, undefined, subMgr);

    const res = await handler(req('GET', '/api/accounts/stream'));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-raiflow-stream-id')).toBeTruthy();
  });

  it('accepts ?accounts= query for initial bulk subscribe', async () => {
    const { runtime } = createTestRuntime();
    const subMgr = new SubscriptionManager();
    const handler = createHandler(runtime, createTestConfig(), undefined, undefined, subMgr);

    const res = await handler(req('GET', '/api/accounts/stream?accounts=nano_1a,nano_1b'));
    expect(res.status).toBe(200);
  });
});

describe('Watch / Unwatch', () => {
  function setup() {
    const { runtime } = createTestRuntime();
    const account = {
      id: 'acc-1',
      type: 'watched',
      address: 'nano_1watch1111111111111111111111111111111111111111111111111111',
      label: null,
      balanceRaw: '0',
      pendingRaw: '0',
      frontier: null,
      representative: null,
      derivationIndex: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    (runtime as any).accountStore = {
      get: vi.fn().mockResolvedValue(account),
      getByAddress: vi.fn().mockResolvedValue(account),
      list: vi.fn().mockResolvedValue([account]),
      update: vi.fn().mockResolvedValue(account),
      create: vi.fn().mockResolvedValue(account),
    };

    const subMgr = new SubscriptionManager();
    const accountSync = new AccountStateSync(
      { getClient: vi.fn().mockReturnValue({ accountInfo: vi.fn().mockResolvedValue(null) }) } as any,
      (runtime as any).accountStore,
      { addAccount: vi.fn(), removeAccount: vi.fn() },
      (event) => subMgr.publish(event),
      undefined,
    );

    const handler = createHandler(runtime, createTestConfig(), undefined, accountSync, subMgr);
    return { runtime, handler, account, subMgr };
  }

  it('POST /api/accounts/:id/watch returns 204 with valid stream ID', async () => {
    const { handler, account } = setup();

    // Open SSE first
    const sseRes = await handler(req('GET', '/api/accounts/stream'));
    const streamId = sseRes.headers.get('x-raiflow-stream-id')!;

    const res = await handler(req('POST', `/api/accounts/${account.id}/watch`, {
      headers: { 'X-Raiflow-Stream-Id': streamId },
    }));

    expect(res.status).toBe(204);
  });

  it('POST /api/accounts/:id/watch rejects missing stream ID', async () => {
    const { handler, account } = setup();

    const res = await handler(req('POST', `/api/accounts/${account.id}/watch`));
    expect(res.status).toBe(400);
  });

  it('DELETE /api/accounts/:id/watch returns 204', async () => {
    const { handler, account } = setup();

    const sseRes = await handler(req('GET', '/api/accounts/stream'));
    const streamId = sseRes.headers.get('x-raiflow-stream-id')!;

    await handler(req('POST', `/api/accounts/${account.id}/watch`, {
      headers: { 'X-Raiflow-Stream-Id': streamId },
    }));

    const res = await handler(req('DELETE', `/api/accounts/${account.id}/watch`, {
      headers: { 'X-Raiflow-Stream-Id': streamId },
    }));

    expect(res.status).toBe(204);
  });
});
