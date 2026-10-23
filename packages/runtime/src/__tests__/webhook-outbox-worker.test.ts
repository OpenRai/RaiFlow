import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RaiFlowEvent, WebhookEndpoint } from '@openrai/model';
import type { WebhookOutboxAttempt, WebhookOutboxDelivery, WebhookOutboxStore } from '@openrai/storage';
import { WebhookOutboxWorker } from '../webhook-outbox-worker.js';
import { Runtime } from '../runtime.js';

const endpoint: WebhookEndpoint = {
  id: 'webhook-1',
  url: 'https://example.test/events',
  secret: 'webhook-secret',
  eventTypes: ['invoice.*'],
  createdAt: '2026-10-22T00:00:00.000Z',
};

const event: RaiFlowEvent = {
  id: 'event-stable-1',
  type: 'invoice.completed',
  timestamp: '2026-10-22T00:00:00.000Z',
  data: { invoice: { id: 'invoice-1' } },
  resourceId: 'invoice-1',
  resourceType: 'invoice',
};

afterEach(() => vi.unstubAllGlobals());

describe('WebhookOutboxWorker', () => {
  it('does not perform HTTP delivery inline with event emission when an outbox is configured', async () => {
    const deliver = vi.fn(async () => {});
    const runtime = new Runtime({
      eventStore: {
        append: vi.fn(async () => {}),
        list: vi.fn(async () => []),
      },
      webhookDelivery: { deliver, shutdown: vi.fn() },
      webhookOutboxStore: {
        claimReady: vi.fn(async () => []),
        recordAttempt: vi.fn(async () => true),
      },
    });

    await (runtime as any).emitV2Event(event);

    expect(deliver).not.toHaveBeenCalled();
  });

  it('records failed attempts and retries the same persisted event', async () => {
    let attemptCount = 0;
    let status: WebhookOutboxAttempt['status'] | undefined;
    const delivery: WebhookOutboxDelivery = { id: 'outbox-1', event, endpoint, attemptCount };
    const store: WebhookOutboxStore = {
      claimReady: vi.fn(async () => [{ ...delivery, attemptCount }]),
      recordAttempt: vi.fn(async (_id, _workerId, attempt) => {
        attemptCount = attempt.number;
        status = attempt.status;
        return true;
      }),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('try later', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const worker = new WebhookOutboxWorker(store, { timeoutMs: 500 });

    await worker.runOnce();
    expect(store.recordAttempt).toHaveBeenLastCalledWith('outbox-1', expect.any(String), expect.objectContaining({
      number: 1,
      status: 'retry',
      responseCode: 503,
      responseBody: 'try later',
      error: 'HTTP 503',
      nextRetryAt: expect.any(String),
    }));
    expect(status).toBe('retry');

    await worker.runOnce();
    expect(store.recordAttempt).toHaveBeenLastCalledWith('outbox-1', expect.any(String), expect.objectContaining({
      number: 2,
      status: 'delivered',
      responseCode: 204,
      nextRetryAt: null,
    }));
    expect(status).toBe('delivered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(new Headers(init.headers).get('X-RaiFlow-Event-Id')).toBe(event.id);
      expect(init.body).toBe(JSON.stringify(event));
    }
  });

  it('marks terminal receiver errors as failed without scheduling another attempt', async () => {
    const store: WebhookOutboxStore = {
      claimReady: vi.fn(async () => [{ id: 'outbox-1', event, endpoint, attemptCount: 0 }]),
      recordAttempt: vi.fn(async () => true),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad request', { status: 400 })));
    const worker = new WebhookOutboxWorker(store);

    await worker.runOnce();

    expect(store.recordAttempt).toHaveBeenCalledWith('outbox-1', expect.any(String), expect.objectContaining({
      number: 1,
      status: 'failed',
      responseCode: 400,
      nextRetryAt: null,
    }));
  });
});
