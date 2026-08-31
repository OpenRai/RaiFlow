import type { RaiFlowClient } from '../client.js';

export interface AllocateSubaccountsOptions {
  namespace: string;
  keys: string[];
  policy?: 'manual';
  idempotencyKey: string;
}

export interface AllocatedSubaccount {
  key: string;
  address: string;
  accountId: string;
}

export class SubaccountsResource {
  constructor(private client: RaiFlowClient) {}

  /** Allocate deterministic managed accounts for an application namespace. */
  async allocate(options: AllocateSubaccountsOptions): Promise<{ data: AllocatedSubaccount[] }> {
    const { idempotencyKey, ...body } = options;
    return this.client.request<{ data: AllocatedSubaccount[] }>('POST', '/subaccounts/allocate', body, {
      'Idempotency-Key': idempotencyKey,
    });
  }
}
