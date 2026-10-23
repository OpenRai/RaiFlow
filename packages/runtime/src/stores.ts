// @openrai/runtime — in-memory store implementations for tests and embedding.

import type {
  EventStore,
  IdempotencyRecord,
  IdempotencyReplayStore,
  Invoice,
  InvoiceStore,
  Payment,
  PaymentStore,
} from '@openrai/model';

export function createInvoiceStore(): InvoiceStore {
  const invoices = new Map<string, Invoice>();
  const idempotencyKeys = new Map<string, string>();

  return {
    async create(invoice, idempotencyKey) {
      const key = idempotencyKey ?? invoice.idempotencyKey ?? undefined;
      const existingId = key ? idempotencyKeys.get(key) : undefined;
      const existing = existingId ? invoices.get(existingId) : undefined;
      if (existing) return existing;
      invoices.set(invoice.id, invoice);
      if (key) idempotencyKeys.set(key, invoice.id);
      return invoice;
    },
    async get(id) {
      return invoices.get(id);
    },
    async getByAccountKeyAndInvoiceKey(accountKey, invoiceKey) {
      return [...invoices.values()].find((invoice) =>
        invoice.accountKey === accountKey && invoice.invoiceKey === invoiceKey,
      );
    },
    async list(filter) {
      return [...invoices.values()].filter((invoice) => !filter?.status || invoice.status === filter.status);
    },
    async listByAccountKey(accountKey) {
      return [...invoices.values()].filter((invoice) => invoice.accountKey === accountKey);
    },
    async update(id, patch) {
      const existing = invoices.get(id);
      if (!existing) throw new Error(`Invoice not found: ${id}`);
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      invoices.set(id, updated);
      return updated;
    },
    async transition(id, expectedStatus, patch) {
      const existing = invoices.get(id);
      if (!existing || existing.status !== expectedStatus) return undefined;
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      invoices.set(id, updated);
      return updated;
    },
    async getByPayAddress(address, status) {
      return [...invoices.values()].filter((invoice) =>
        invoice.payAddress === address && (!status || invoice.status === status),
      );
    },
    async getByIdempotencyKey(key) {
      return idempotencyKeys.get(key);
    },
  };
}

export function createPaymentStore(): PaymentStore {
  const payments = new Map<string, Payment>();
  const byBlockHash = new Map<string, string>();
  return {
    async create(payment) {
      payments.set(payment.id, payment);
      byBlockHash.set(payment.blockHash, payment.id);
      return payment;
    },
    async get(id) {
      return payments.get(id);
    },
    async getByBlockHash(hash) {
      const id = byBlockHash.get(hash);
      return id ? payments.get(id) : undefined;
    },
    async listByInvoice(invoiceId) {
      return [...payments.values()].filter((payment) => payment.invoiceId === invoiceId);
    },
  };
}

export function createEventStore(): EventStore {
  const events: import('@openrai/model').RaiFlowEvent[] = [];
  return {
    async append(event) {
      event.sequence = events.length + 1;
      events.push(event);
    },
    async list(options = {}) {
      return events
        .filter((event) => options.after === undefined || (event.sequence ?? 0) > Number(options.after))
        .filter((event) => options.type === undefined || event.type === options.type)
        .filter((event) => options.resourceType === undefined || event.resourceType === options.resourceType)
        .filter((event) => options.resourceId === undefined || event.resourceId === options.resourceId)
        .slice(0, options.limit ?? 100);
    },
  };
}

export function createIdempotencyReplayStore(): IdempotencyReplayStore {
  const records = new Map<string, IdempotencyRecord>();

  function scoped(scope: string, key: string): string {
    return `${scope}:${key}`;
  }

  return {
    async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
      return records.get(scoped(scope, key));
    },

    async put(scope: string, key: string, resourceType: string, resourceId: string): Promise<IdempotencyRecord> {
      const storeKey = scoped(scope, key);
      const existing = records.get(storeKey);
      if (existing) return existing;
      const created: IdempotencyRecord = {
        key,
        scope,
        resourceType,
        resourceId,
        createdAt: new Date().toISOString(),
      };
      records.set(storeKey, created);
      return created;
    },
  };
}
