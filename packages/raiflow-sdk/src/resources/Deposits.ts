import type { Refund } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export interface CreateRefundOptions {
  /** Destination address verified by the application. RaiFlow never infers it from the sender. */
  destination: string;
  amountRaw: string;
  idempotencyKey: string;
}

export class DepositsResource {
  constructor(private client: RaiFlowClient) {}

  async listRefunds(depositId: string): Promise<{ data: Refund[] }> {
    return this.client.request<{ data: Refund[] }>(
      'GET', `/deposits/${encodeURIComponent(depositId)}/refunds`,
    );
  }

  async refund(depositId: string, options: CreateRefundOptions): Promise<Refund> {
    const { idempotencyKey, ...body } = options;
    return this.client.request<Refund>(
      'POST', `/deposits/${encodeURIComponent(depositId)}/refunds`, body,
      { 'Idempotency-Key': idempotencyKey },
    );
  }
}
