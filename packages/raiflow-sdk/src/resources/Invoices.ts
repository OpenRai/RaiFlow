import type { Invoice, Payment, RaiFlowEvent, CompletionPolicy } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export interface CreateInvoiceOptions {
  recipientAccount: string;
  expectedAmountRaw: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  completionPolicy?: CompletionPolicy;
}

export interface ListInvoicesOptions {
  status?: string;
}

export interface ListEventsOptions {
  after?: string;
}

export class InvoicesResource {
  constructor(private client: RaiFlowClient) {}

  public async create(
    options: CreateInvoiceOptions,
    idempotencyKey?: string,
  ): Promise<Invoice> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    return this.client.request<Invoice>('POST', '/invoices', options, headers);
  }

  public async get(id: string): Promise<Invoice> {
    return this.client.request<Invoice>('GET', `/invoices/${id}`);
  }

  public async list(options?: ListInvoicesOptions): Promise<{ data: Invoice[] }> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    const query = params.toString();
    const path = query ? `/invoices?${query}` : '/invoices';
    return this.client.request<{ data: Invoice[] }>('GET', path);
  }

  public async cancel(id: string): Promise<Invoice> {
    return this.client.request<Invoice>('POST', `/invoices/${id}/cancel`);
  }

  public async listPayments(id: string): Promise<{ data: Payment[] }> {
    return this.client.request<{ data: Payment[] }>('GET', `/invoices/${id}/payments`);
  }

  public async listEvents(
    id: string,
    options?: ListEventsOptions,
  ): Promise<{ data: RaiFlowEvent[] }> {
    const params = new URLSearchParams();
    if (options?.after) params.set('after', options.after);
    const query = params.toString();
    const path = query
      ? `/invoices/${id}/events?${query}`
      : `/invoices/${id}/events`;
    return this.client.request<{ data: RaiFlowEvent[] }>('GET', path);
  }
}
