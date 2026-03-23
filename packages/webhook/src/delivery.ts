// @openrai/webhook — Webhook delivery engine with retry & exponential backoff

import type { RaiFlowEvent, WebhookEndpoint } from '@openrai/model';
import { signPayload } from './signing.js';

export interface DeliveryConfig {
  /** Max retry attempts per event. Default 5. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default 1000. */
  baseDelayMs?: number;
  /** Max delay between retries in ms. Default 60000. */
  maxDelayMs?: number;
  /** Request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

export interface WebhookDelivery {
  /**
   * Deliver an event to all matching endpoints.
   * The first attempt for each endpoint is awaited; retries happen in the background.
   */
  deliver(event: RaiFlowEvent, endpoints: WebhookEndpoint[]): Promise<void>;
  /** Shut down the delivery engine, cancelling any pending retry timers. */
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute backoff with jitter: `min(base * 2^attempt, max) * (0.5 + rand * 0.5)` */
function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  return delay * (0.5 + Math.random() * 0.5);
}

/** Attempt to POST a webhook payload to a single endpoint. */
async function postToEndpoint(
  endpoint: WebhookEndpoint,
  event: RaiFlowEvent,
  body: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const signature = signPayload(body, endpoint.secret);
    const response = await fetch(endpoint.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-RaiFlow-Signature': signature,
        'X-RaiFlow-Event': event.type,
        'X-RaiFlow-Event-Id': event.id,
      },
      body,
    });

    if (!response.ok) {
      console.log(
        `[webhook] delivery failed for endpoint ${endpoint.id} (${endpoint.url}): HTTP ${response.status}`,
      );
      return false;
    }

    console.log(
      `[webhook] delivered event ${event.id} (${event.type}) to endpoint ${endpoint.id} (${endpoint.url})`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `[webhook] delivery error for endpoint ${endpoint.id} (${endpoint.url}): ${message}`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Schedule retries in the background. Returns a timer handle set for cleanup. */
function scheduleRetries(
  endpoint: WebhookEndpoint,
  event: RaiFlowEvent,
  body: string,
  attempt: number,
  config: Required<DeliveryConfig>,
  pendingTimers: Set<ReturnType<typeof setTimeout>>,
): void {
  if (attempt >= config.maxRetries) {
    console.log(
      `[webhook] giving up on endpoint ${endpoint.id} (${endpoint.url}) after ${config.maxRetries} retries for event ${event.id}`,
    );
    return;
  }

  const delay = computeBackoff(attempt, config.baseDelayMs, config.maxDelayMs);
  console.log(
    `[webhook] scheduling retry ${attempt + 1}/${config.maxRetries} for endpoint ${endpoint.id} in ${Math.round(delay)}ms`,
  );

  const timer = setTimeout(async () => {
    pendingTimers.delete(timer);
    const ok = await postToEndpoint(endpoint, event, body, config.timeoutMs);
    if (!ok) {
      scheduleRetries(endpoint, event, body, attempt + 1, config, pendingTimers);
    }
  }, delay);

  pendingTimers.add(timer);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `WebhookDelivery` instance.
 *
 * @example
 * ```ts
 * const delivery = createWebhookDelivery({ maxRetries: 3 });
 * await delivery.deliver(event, endpoints);
 * ```
 */
export function createWebhookDelivery(config: DeliveryConfig = {}): WebhookDelivery {
  const resolved: Required<DeliveryConfig> = {
    maxRetries: config.maxRetries ?? 5,
    baseDelayMs: config.baseDelayMs ?? 1000,
    maxDelayMs: config.maxDelayMs ?? 60_000,
    timeoutMs: config.timeoutMs ?? 10_000,
  };

  // Track all pending retry timers so shutdown() can cancel them
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  return {
    async deliver(event, endpoints) {
      // Filter endpoints that subscribe to this event type
      const matching = endpoints.filter((ep) => ep.eventTypes.includes(event.type));

      if (matching.length === 0) return;

      const body = JSON.stringify(event);

      // Fire first attempt for all matching endpoints in parallel; await them all
      await Promise.all(
        matching.map(async (endpoint) => {
          const ok = await postToEndpoint(endpoint, event, body, resolved.timeoutMs);
          if (!ok) {
            scheduleRetries(endpoint, event, body, 0, resolved, pendingTimers);
          }
        }),
      );
    },

    shutdown() {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      console.log('[webhook] delivery engine shut down');
    },
  };
}
