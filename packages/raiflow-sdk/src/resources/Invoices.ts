import type { CreateInvoiceRequest, Invoice, InvoiceStatus, Payment } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export type CreateInvoiceOptions = CreateInvoiceRequest;

export interface ListInvoicesOptions {
  status?: InvoiceStatus;
}

export class InvoicesResource {
  constructor(private client: RaiFlowClient) {}

  public async create(
    options: CreateInvoiceOptions,
    idempotencyKey: string,
  ): Promise<Invoice> {
    const headers: Record<string, string> = {};
    headers['Idempotency-Key'] = idempotencyKey;
    return this.client.request<Invoice>('POST', '/invoices', options, headers);
  }

  public async get(id: string): Promise<Invoice> {
    return this.client.request<Invoice>('GET', `/invoices/${id}`);
  }

  /** Resolve an invoice by the stable application account/invoice identity. */
  public async getByKey(accountKey: string, invoiceKey: string | null): Promise<Invoice | undefined> {
    const params = new URLSearchParams({ accountKey });
    if (invoiceKey !== null) params.set('invoiceKey', invoiceKey);
    try {
      return await this.client.request<Invoice>('GET', `/invoices/by-key?${params.toString()}`);
    } catch (error) {
      // RaiFlow returns a normal 404 for an unknown compound key. Keep the
      // resource ergonomic while preserving other API failures for callers.
      if (error instanceof Error && /404|not found/i.test(error.message)) return undefined;
      throw error;
    }
  }

  public async list(options?: ListInvoicesOptions): Promise<{ data: Invoice[] }> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    const query = params.toString();
    const path = query ? `/invoices?${query}` : '/invoices';
    return this.client.request<{ data: Invoice[] }>('GET', path);
  }

  public async listByAccountKey(accountKey: string): Promise<{ data: Invoice[] }> {
    const params = new URLSearchParams({ accountKey });
    return this.client.request<{ data: Invoice[] }>('GET', `/invoices?${params.toString()}`);
  }

  public async cancel(id: string, idempotencyKey: string): Promise<Invoice> {
    const headers: Record<string, string> = {};
    headers['Idempotency-Key'] = idempotencyKey;
    return this.client.request<Invoice>('POST', `/invoices/${id}/cancel`, undefined, headers);
  }

  public async listPayments(id: string): Promise<{ data: Payment[] }> {
    return this.client.request<{ data: Payment[] }>('GET', `/invoices/${id}/payments`);
  }
}
