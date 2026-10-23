import type { Account, Deposit, UpdateAccountRequest } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export interface CreateManagedAccountOptions {
  accountKey: string;
  label?: string;
  representative?: string;
  idempotencyKey: string;
}

export interface CreateWatchedAccountOptions {
  address: string;
  label?: string;
  idempotencyKey: string;
}

export interface ListAccountsOptions {
  type?: 'managed' | 'watched';
}

export class AccountsResource {
  constructor(private client: RaiFlowClient) {}

  async createManaged(options: CreateManagedAccountOptions): Promise<Account> {
    const { idempotencyKey, ...body } = options;
    return this.client.request<Account>('POST', '/accounts', {
      type: 'managed',
      ...body,
    }, { 'Idempotency-Key': idempotencyKey });
  }

  async createWatched(options: CreateWatchedAccountOptions): Promise<Account> {
    const { idempotencyKey, ...body } = options;
    return this.client.request<Account>('POST', '/accounts', {
      type: 'watched',
      ...body,
    }, { 'Idempotency-Key': idempotencyKey });
  }

  async list(options?: ListAccountsOptions): Promise<{ data: Account[] }> {
    const params = new URLSearchParams();
    if (options?.type) params.set('type', options.type);
    const query = params.toString();
    const path = query ? `/accounts?${query}` : '/accounts';
    return this.client.request<{ data: Account[] }>('GET', path);
  }

  async get(id: string): Promise<Account> {
    return this.client.request<Account>('GET', `/accounts/${id}`);
  }

  async update(id: string, patch: UpdateAccountRequest, idempotencyKey: string): Promise<Account> {
    return this.client.request<Account>('PATCH', `/accounts/${id}`, patch, { 'Idempotency-Key': idempotencyKey });
  }

  async delete(id: string, idempotencyKey: string): Promise<void> {
    await this.client.request<void>('DELETE', `/accounts/${id}`, undefined, { 'Idempotency-Key': idempotencyKey });
  }

  async listDeposits(id: string): Promise<{ data: Deposit[] }> {
    return this.client.request<{ data: Deposit[] }>('GET', `/accounts/${id}/deposits`);
  }
}
