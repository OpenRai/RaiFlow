import type { Invoice } from '@openrai/model';
import type { RaiFlowClient } from '../client.js';

export interface InvoiceAccountBalance {
  balanceRaw: string;
  pendingRaw: string;
  address: string;
}

export interface InvoiceAccountAggregatedBalance {
  confirmedAmountRaw: string;
  pendingAmountRaw: string;
  invoiceCount: number;
  addresses: string[];
}

export class InvoiceAccountsResource {
  constructor(private client: RaiFlowClient) {}

  /**
   * Get the live on-chain balance for a specific invoice account address.
   * If invoiceKey is omitted, returns the balance for the shared address (accountKey only).
   * Also triggers JIT receive-block housekeeping for this address.
   */
  public async getBalance(
    accountKey: string,
    invoiceKey?: string,
  ): Promise<InvoiceAccountBalance> {
    const params = new URLSearchParams();
    if (invoiceKey) params.set('invoiceKey', invoiceKey);
    const query = params.toString();
    const path = `/invoice-accounts/${encodeURIComponent(accountKey)}/balance${query ? `?${query}` : ''}`;
    return this.client.request<InvoiceAccountBalance>('GET', path);
  }

  /**
   * Get aggregated balance across all invoices for this accountKey.
   * Sums confirmed received amounts and pending open invoice amounts from the DB.
   * No RPC fan-out — fast, DB-only.
   */
  public async getAggregatedBalance(
    accountKey: string,
  ): Promise<InvoiceAccountAggregatedBalance> {
    return this.client.request<InvoiceAccountAggregatedBalance>(
      'GET',
      `/invoice-accounts/${encodeURIComponent(accountKey)}/aggregated-balance`,
    );
  }

  /**
   * List all invoices associated with this accountKey, across all invoiceKeys.
   */
  public async listInvoices(accountKey: string): Promise<{ data: Invoice[] }> {
    return this.client.request<{ data: Invoice[] }>(
      'GET',
      `/invoice-accounts/${encodeURIComponent(accountKey)}/invoices`,
    );
  }
}
