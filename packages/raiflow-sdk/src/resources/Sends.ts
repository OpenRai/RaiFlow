import type { Send } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export interface QueueSendOptions {
  destination: string;
  amountRaw: string;
  idempotencyKey: string;
}

export class SendsResource {
  constructor(private client: RaiFlowClient) {}

  async queue(accountId: string, options: QueueSendOptions): Promise<Send> {
    return this.client.request<Send>('POST', `/accounts/${accountId}/sends`, options);
  }

  async listByAccount(accountId: string): Promise<{ data: Send[] }> {
    return this.client.request<{ data: Send[] }>('GET', `/accounts/${accountId}/sends`);
  }

  async get(id: string): Promise<Send> {
    return this.client.request<Send>('GET', `/sends/${id}`);
  }
}
