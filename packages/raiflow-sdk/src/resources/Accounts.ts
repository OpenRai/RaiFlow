import type { Account, AccountEvent, Receivable, UpdateAccountRequest } from '@openrai/model';
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

  async receivable(id: string): Promise<{ data: Receivable[] }> {
    return this.client.request<{ data: Receivable[] }>('GET', `/accounts/${id}/receivable`);
  }

  async watch(accountId: string, options?: { signal?: AbortSignal }): Promise<AsyncIterable<AccountEvent>> {
    const account = await this.client.request<Account>('GET', `/accounts/${accountId}`);
    const sse = this.client.sseConnection;
    const streamId = await sse.getStreamId();

    await this.client.request('POST', `/accounts/${accountId}/watch`, undefined, {
      'X-Raiflow-Stream-Id': streamId,
    });

    const iterable = sse.watch(account.address);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        this.client.request('DELETE', `/accounts/${accountId}/watch`, undefined, {
          'X-Raiflow-Stream-Id': streamId,
        }).catch(() => {});
        sse.unwatch(account.address);
      }, { once: true });
    }

    return iterable;
  }
}
