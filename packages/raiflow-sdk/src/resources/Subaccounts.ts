import type { RaiFlowClient } from '../client.js';

export interface AllocateSubaccountsOptions {
  namespace: string;
  keys: string[];
  /** External addresses used when the runtime is non-custodial. */
  addresses?: Record<string, string>;
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

  /** Allocate an application subaccount matrix; non-custodial runtimes register watched addresses. */
  async allocate(options: AllocateSubaccountsOptions): Promise<{ data: AllocatedSubaccount[] }> {
    const { idempotencyKey, ...body } = options;
    return this.client.request<{ data: AllocatedSubaccount[] }>('POST', '/subaccounts/allocate', body, {
      'Idempotency-Key': idempotencyKey,
    });
  }
}
