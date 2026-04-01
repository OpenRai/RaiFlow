// @openrai/raiflow-sdk — SDK client tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RaiFlowClient } from '../client.js';
import type { Invoice, Payment, RaiFlowEvent, WebhookEndpoint } from '@openrai/model';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockFetch() {
  return vi.fn().mockResolvedValue(new Response('{}'));
}

function mockResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
}

const TEST_INVOICE: Invoice = {
  id: 'inv-1',
  status: 'open',
  currency: 'XNO',
  expectedAmountRaw: '1000000000000000000000000000000',
  confirmedAmountRaw: '0',
  recipientAccount: 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
  createdAt: '2026-03-31T00:00:00.000Z',
  completionPolicy: { type: 'at_least' },
};

const TEST_PAYMENT: Payment = {
  id: 'pay-1',
  invoiceId: 'inv-1',
  status: 'confirmed',
  currency: 'XNO',
  amountRaw: '1000000000000000000000000000000',
  recipientAccount: 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
  sendBlockHash: 'abc123',
  confirmedAt: '2026-03-31T00:01:00.000Z',
};

const TEST_EVENT: RaiFlowEvent = {
  id: 'evt-1',
  type: 'invoice.created',
  createdAt: '2026-03-31T00:00:00.000Z',
  data: { invoice: TEST_INVOICE },
};

const TEST_ENDPOINT: WebhookEndpoint = {
  id: 'wh-1',
  url: 'https://example.com/hook',
  secret: 'test-secret',
  eventTypes: ['invoice.created'],
  createdAt: '2026-03-31T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// RaiFlowClient
// ---------------------------------------------------------------------------

describe('RaiFlowClient', () => {
  describe('initialization', () => {
    it('creates client with baseUrl', () => {
      const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
      expect(client).toBeDefined();
      expect(client.invoices).toBeDefined();
      expect(client.webhooks).toBeDefined();
    });

    it('strips trailing slashes from baseUrl', () => {
      const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000///' });
      expect(client).toBeDefined();
    });

    it('accepts apiKey option', () => {
      const client = RaiFlowClient.initialize({
        baseUrl: 'http://localhost:3000',
        apiKey: 'my-key',
      });
      expect(client).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// InvoicesResource
// ---------------------------------------------------------------------------

describe('InvoicesResource', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('create sends POST to /invoices', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(TEST_INVOICE, { status: 201 }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const invoice = await client.invoices.create({
      recipientAccount: TEST_INVOICE.recipientAccount,
      expectedAmountRaw: TEST_INVOICE.expectedAmountRaw,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices');
    expect(call[1]?.method).toBe('POST');
    expect(invoice).toEqual(TEST_INVOICE);
  });

  it('create includes Idempotency-Key header when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(TEST_INVOICE, { status: 201 }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    await client.invoices.create(
      { recipientAccount: TEST_INVOICE.recipientAccount, expectedAmountRaw: '1' },
      'idem-key-123',
    );

    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect((call[1]?.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-key-123');
  });

  it('create passes completionPolicy in body', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ...TEST_INVOICE, completionPolicy: { type: 'exact' } }, { status: 201 }),
    );

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    await client.invoices.create({
      recipientAccount: TEST_INVOICE.recipientAccount,
      expectedAmountRaw: TEST_INVOICE.expectedAmountRaw,
      completionPolicy: { type: 'exact' },
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.completionPolicy).toEqual({ type: 'exact' });
  });

  it('get sends GET to /invoices/:id', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(TEST_INVOICE));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const invoice = await client.invoices.get('inv-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices/inv-1');
    expect(invoice).toEqual(TEST_INVOICE);
  });

  it('list sends GET to /invoices', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [TEST_INVOICE] }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const result = await client.invoices.list();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices');
    expect(result.data).toHaveLength(1);
  });

  it('list sends GET to /invoices?status=open', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [TEST_INVOICE] }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    await client.invoices.list({ status: 'open' });

    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices?status=open');
  });

  it('cancel sends POST to /invoices/:id/cancel', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ...TEST_INVOICE, status: 'canceled' }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const invoice = await client.invoices.cancel('inv-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices/inv-1/cancel');
    expect(call[1]?.method).toBe('POST');
    expect(invoice.status).toBe('canceled');
  });

  it('listPayments sends GET to /invoices/:id/payments', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [TEST_PAYMENT] }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const result = await client.invoices.listPayments('inv-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices/inv-1/payments');
    expect(result.data).toHaveLength(1);
  });

  it('listEvents sends GET to /invoices/:id/events', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [TEST_EVENT] }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const result = await client.invoices.listEvents('inv-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices/inv-1/events');
    expect(result.data).toHaveLength(1);
  });

  it('listEvents sends GET to /invoices/:id/events?after=evt-1', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [] }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    await client.invoices.listEvents('inv-1', { after: 'evt-1' });

    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/invoices/inv-1/events?after=evt-1');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not found', { status: 404 }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    await expect(client.invoices.get('non-existent')).rejects.toThrow('RaiFlow API error 404');
  });

  it('sends Authorization header with apiKey', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(TEST_INVOICE, { status: 201 }));

    const client = RaiFlowClient.initialize({
      baseUrl: 'http://localhost:3000',
      apiKey: 'secret-key',
    });
    await client.invoices.create({
      recipientAccount: TEST_INVOICE.recipientAccount,
      expectedAmountRaw: TEST_INVOICE.expectedAmountRaw,
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect((call[1]?.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-key');
  });
});

// ---------------------------------------------------------------------------
// WebhooksResource
// ---------------------------------------------------------------------------

describe('WebhooksResource', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('create sends POST to /webhooks', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(TEST_ENDPOINT, { status: 201 }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const endpoint = await client.webhooks.create({
      url: 'https://example.com/hook',
      eventTypes: ['invoice.created'],
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/webhooks');
    expect(call[1]?.method).toBe('POST');
    expect(endpoint).toEqual(TEST_ENDPOINT);
  });

  it('create includes secret when provided', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(TEST_ENDPOINT, { status: 201 }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    await client.webhooks.create({
      url: 'https://example.com/hook',
      eventTypes: ['invoice.created'],
      secret: 'my-secret',
    });

    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.secret).toBe('my-secret');
  });

  it('list sends GET to /webhooks', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ data: [TEST_ENDPOINT] }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    const result = await client.webhooks.list();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/webhooks');
    expect(result.data).toHaveLength(1);
  });

  it('delete sends DELETE to /webhooks/:id', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const client = RaiFlowClient.initialize({ baseUrl: 'http://localhost:3000' });
    await client.webhooks.delete('wh-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit?];
    expect(call[0]).toBe('http://localhost:3000/webhooks/wh-1');
    expect(call[1]?.method).toBe('DELETE');
  });
});