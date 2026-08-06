import type { WebhookEndpoint, RaiFlowEventType } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export interface CreateWebhookOptions {
  url: string;
  eventTypes: RaiFlowEventType[];
  secret?: string;
}

export class WebhooksResource {
  constructor(private client: RaiFlowClient) {}

  public async create(options: CreateWebhookOptions, idempotencyKey: string): Promise<WebhookEndpoint> {
    return this.client.request<WebhookEndpoint>('POST', '/webhooks', {
      url: options.url,
      eventTypes: options.eventTypes,
      ...(options.secret ? { secret: options.secret } : {}),
    }, { 'Idempotency-Key': idempotencyKey });
  }

  public async list(): Promise<{ data: WebhookEndpoint[] }> {
    return this.client.request<{ data: WebhookEndpoint[] }>('GET', '/webhooks');
  }

  public async delete(id: string, idempotencyKey: string): Promise<void> {
    await this.client.request<void>('DELETE', `/webhooks/${id}`, undefined, { 'Idempotency-Key': idempotencyKey });
  }
}
