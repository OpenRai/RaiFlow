import type { Account, UpdateAccountRequest } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export interface CreateManagedAccountOptions {
  label?: string;
  representative?: string;
  idempotencyKey?: string;
}

export interface CreateWatchedAccountOptions {
  address: string;
  label?: string;
}

export interface ListAccountsOptions {
  type?: 'managed' | 'watched';
}

export class AccountsResource {
  constructor(private client: RaiFlowClient) {}

  async createManaged(options: CreateManagedAccountOptions): Promise<Account> {
    return this.client.request<Account>('POST', '/accounts', {
      type: 'managed',
      ...options,
    });
  }

  async createWatched(options: CreateWatchedAccountOptions): Promise<Account> {
    return this.client.request<Account>('POST', '/accounts', {
      type: 'watched',
      ...options,
    });
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

  async update(id: string, patch: UpdateAccountRequest): Promise<Account> {
    return this.client.request<Account>('PATCH', `/accounts/${id}`, patch);
  }
}
