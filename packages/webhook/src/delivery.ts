// @openrai/webhook — Webhook delivery engine with retry & exponential backoff

import type { WebhookEndpoint } from '@openrai/model';
import { signPayload } from './signing.js';

/** Minimal event shape required for webhook delivery */
interface WebhookEventData {
  id: string;
  type: string;
}

function getEventData(event: unknown): WebhookEventData {
  return event as WebhookEventData;
}

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
  deliver(event: unknown, endpoints: WebhookEndpoint[]): Promise<void>;
  /** Shut down the delivery engine, cancelling any pending retry timers. */
  shutdown(): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute backoff with ±25% jitter around the exponential delay. */
function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  return delay * (0.75 + Math.random() * 0.5);
}

type DeliveryOutcome = 'delivered' | 'retry' | 'terminal';

/** Attempt to POST a webhook payload to a single endpoint. */
async function postToEndpoint(
  endpoint: WebhookEndpoint,
  event: unknown,
  body: string,
  timeoutMs: number,
): Promise<DeliveryOutcome> {
  const eventData = getEventData(event);
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
        'X-RaiFlow-Event': eventData.type,
        'X-RaiFlow-Event-Id': eventData.id,
      },
      body,
    });

    if (!response.ok) {
      console.log(
        `[webhook] delivery failed for endpoint ${endpoint.id} (${endpoint.url}): HTTP ${response.status}`,
      );
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        return 'terminal';
      }
      return 'retry';
    }

    console.log(
      `[webhook] delivered event ${eventData.id} (${eventData.type}) to endpoint ${endpoint.id} (${endpoint.url})`,
    );
    return 'delivered';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `[webhook] delivery error for endpoint ${endpoint.id} (${endpoint.url}): ${message}`,
    );
    return 'retry';
  } finally {
    clearTimeout(timer);
  }
}

/** Schedule retries in the background. Returns a timer handle set for cleanup. */
function scheduleRetries(
  endpoint: WebhookEndpoint,
  event: unknown,
  body: string,
  attempt: number,
  config: Required<DeliveryConfig>,
  pendingTimers: Set<ReturnType<typeof setTimeout>>,
): void {
  const eventData = getEventData(event);
  if (attempt >= config.maxRetries) {
    console.log(
      `[webhook] giving up on endpoint ${endpoint.id} (${endpoint.url}) after ${config.maxRetries} retries for event ${eventData.id}`,
    );
    return;
  }

  const delay = computeBackoff(attempt, config.baseDelayMs, config.maxDelayMs);
  console.log(
    `[webhook] scheduling retry ${attempt + 1}/${config.maxRetries} for endpoint ${endpoint.id} in ${Math.round(delay)}ms`,
  );

  const timer = setTimeout(async () => {
    pendingTimers.delete(timer);
    const outcome = await postToEndpoint(endpoint, event, body, config.timeoutMs);
    if (outcome === 'retry') {
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
      const eventData = getEventData(event);
      const matching = endpoints.filter((ep) =>
        ep.eventTypes.includes('*') || ep.eventTypes.includes(eventData.type),
      );

      if (matching.length === 0) return;

      const body = JSON.stringify(event);

      // Fire first attempt for all matching endpoints in parallel; await them all
      await Promise.all(
        matching.map(async (endpoint) => {
          const outcome = await postToEndpoint(endpoint, event, body, resolved.timeoutMs);
          if (outcome === 'retry') {
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
