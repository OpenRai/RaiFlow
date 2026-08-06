import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEndpoint } from '@openrai/model';
import { createWebhookDelivery } from '../delivery.js';

const endpoint: WebhookEndpoint = {
  id: 'webhook-1',
  url: 'https://example.test/webhook',
  secret: 'secret',
  eventTypes: ['*'],
  createdAt: new Date().toISOString(),
};
const event = { id: 'event-1', type: 'invoice.created' };

describe('webhook delivery policy', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not retry a terminal 4xx response', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const delivery = createWebhookDelivery({ maxRetries: 2, baseDelayMs: 10 });

    await delivery.deliver(event, [endpoint]);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    delivery.shutdown();
  });

  it('retries server failures and signs the exact body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const delivery = createWebhookDelivery({ maxRetries: 1, baseDelayMs: 10 });

    await delivery.deliver(event, [endpoint]);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-RaiFlow-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(init.body).toBe(JSON.stringify(event));
    delivery.shutdown();
  });
});
