// @openrai/webhook — In-memory WebhookEndpoint store

import { randomBytes, randomUUID } from 'node:crypto';
import type { RaiFlowEventType, WebhookEndpoint } from '@openrai/model';

export interface WebhookEndpointStore {
  /** Create a new endpoint. Auto-generates `id`, `createdAt`, and `secret` if not supplied. */
  create(
    endpoint: Omit<WebhookEndpoint, 'id' | 'createdAt'> & { secret?: string },
  ): Promise<WebhookEndpoint>;
  /** Retrieve an endpoint by id. Returns `undefined` if not found. */
  get(id: string): Promise<WebhookEndpoint | undefined>;
  /** List all registered endpoints. */
  list(): Promise<WebhookEndpoint[]>;
  /** Delete an endpoint by id. Returns `true` if it existed. */
  delete(id: string): Promise<boolean>;
  /** List all endpoints subscribed to a given event type. */
  getByEventType(eventType: RaiFlowEventType): Promise<WebhookEndpoint[]>;
}

/**
 * Create an in-memory `WebhookEndpointStore`.
 *
 * @example
 * ```ts
 * const store = createWebhookEndpointStore();
 * const ep = await store.create({ url: 'https://example.com/hook', eventTypes: ['invoice.created'] });
 * ```
 */
export function createWebhookEndpointStore(): WebhookEndpointStore {
  const endpoints = new Map<string, WebhookEndpoint>();

  return {
    async create(input) {
      const id = randomUUID();
      const secret = input.secret ?? randomBytes(32).toString('hex');
      const createdAt = new Date().toISOString();

      const endpoint: WebhookEndpoint = {
        id,
        url: input.url,
        secret,
        eventTypes: input.eventTypes,
        createdAt,
      };

      endpoints.set(id, endpoint);
      return endpoint;
    },

    async get(id) {
      return endpoints.get(id);
    },

    async list() {
      return Array.from(endpoints.values());
    },

    async delete(id) {
      return endpoints.delete(id);
    },

    async getByEventType(eventType) {
      return Array.from(endpoints.values()).filter((ep) =>
        ep.eventTypes.includes(eventType),
      );
    },
  };
}
