import type { RaiFlowClient } from '../client.js';

export interface BatchReceiveOptions {
  accountIds: string[];
  idempotencyKey: string;
}

export interface BatchReceiveResult {
  acceptedAccountIds: string[];
}

export class ReceivesResource {
  constructor(private client: RaiFlowClient) {}

  /** Queue managed-account receivables; RaiFlow owns PoW, signing, retries, and confirmation. */
  async batch(options: BatchReceiveOptions): Promise<BatchReceiveResult> {
    const { idempotencyKey, ...body } = options;
    return this.client.request<BatchReceiveResult>('POST', '/receives/batch', body, {
      'Idempotency-Key': idempotencyKey,
    });
  }
}
