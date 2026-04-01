// @openrai/runtime — In-memory store implementations (prototype-era)
// These stores use the legacy model shapes. Will be replaced with SQLite-backed
// implementations using the v2 model in Slice B4.

import type {
  Invoice,
  InvoiceStatus,
  Payment,
  PaymentStatus,
  EventStore,
} from '@openrai/model';
import type {
  LegacyInvoiceStore,
  LegacyEventStore,
  LegacyRaiFlowEvent,
  LegacyPayment,
  LegacyInvoice,
} from '@openrai/model';

// ---------------------------------------------------------------------------
// InvoiceStore (prototype-era)
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `InvoiceStore` using the prototype-era Invoice shape.
 */
export function createInvoiceStore(): LegacyInvoiceStore {
  const invoices = new Map<string, LegacyInvoice>();
  const idempotencyKeys = new Map<string, string>();

  return {
    async create(invoice: LegacyInvoice, idempotencyKey?: string) {
      if (idempotencyKey !== undefined) {
        const existingId = idempotencyKeys.get(idempotencyKey);
        if (existingId !== undefined) {
          const existing = invoices.get(existingId);
          if (existing !== undefined) {
            return existing;
          }
        }
      }

      invoices.set(invoice.id, invoice);

      if (idempotencyKey !== undefined) {
        idempotencyKeys.set(idempotencyKey, invoice.id);
      }

      return invoice;
    },

    async get(id) {
      return invoices.get(id) as LegacyInvoice | undefined;
    },

    async list(filter) {
      const all = Array.from(invoices.values());
      if (filter?.status === undefined) {
        return all;
      }
      return all.filter((inv) => inv.status === filter.status);
    },

    async update(id, patch) {
      const existing = invoices.get(id);
      if (existing === undefined) {
        throw new Error(`Invoice not found: ${id}`);
      }
      const updated: LegacyInvoice = { ...existing, ...patch };
      invoices.set(id, updated);
      return updated;
    },

    async getByRecipientAccount(account: string, status?: InvoiceStatus) {
      const all = Array.from(invoices.values());
      return all.filter(
        (inv: LegacyInvoice) =>
          inv.recipientAccount === account &&
          (status === undefined || inv.status === status),
      );
    },

    async getByIdempotencyKey(key: string) {
      return idempotencyKeys.get(key);
    },
  };
}

// ---------------------------------------------------------------------------
// PaymentStore (prototype-era)
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `PaymentStore` using the prototype-era Payment shape.
 */
export function createPaymentStore(): LegacyPaymentStore {
  const payments = new Map<string, LegacyPayment>();
  const byBlockHash = new Map<string, string>();

  return {
    async create(payment: LegacyPayment) {
      payments.set(payment.id, payment);
      byBlockHash.set(payment.sendBlockHash, payment.id);
      return payment;
    },

    async get(id) {
      return payments.get(id) as LegacyPayment | undefined;
    },

    async getByBlockHash(hash: string) {
      const id = byBlockHash.get(hash);
      if (id === undefined) return undefined;
      return payments.get(id) as LegacyPayment | undefined;
    },

    async listByInvoice(invoiceId: string) {
      return Array.from(payments.values()).filter(
        (p: LegacyPayment) => p.invoiceId === invoiceId,
      ) as LegacyPayment[];
    },
  };
}

export interface LegacyPaymentStore {
  create(payment: LegacyPayment): Promise<LegacyPayment>;
  get(id: string): Promise<LegacyPayment | undefined>;
  getByBlockHash(hash: string): Promise<LegacyPayment | undefined>;
  listByInvoice(invoiceId: string): Promise<LegacyPayment[]>;
}

// ---------------------------------------------------------------------------
// EventStore (prototype-era)
// ---------------------------------------------------------------------------

/**
 * Extract the invoiceId from a legacy event.
 */
function extractInvoiceId(event: LegacyRaiFlowEvent): string {
  switch (event.type) {
    case 'invoice.created':
    case 'invoice.completed':
    case 'invoice.expired':
    case 'invoice.canceled':
      return (event.data as { invoice: LegacyInvoice }).invoice.id;
    case 'payment.confirmed':
      return (event.data as { invoice: LegacyInvoice }).invoice.id;
  }
}

/**
 * Create an in-memory `EventStore` using the prototype-era event shape.
 */
export function createEventStore(): LegacyEventStore {
  const eventsByInvoice = new Map<string, LegacyRaiFlowEvent[]>();

  return {
    async append(event: LegacyRaiFlowEvent) {
      const invoiceId = extractInvoiceId(event);
      const existing = eventsByInvoice.get(invoiceId);
      if (existing !== undefined) {
        existing.push(event);
      } else {
        eventsByInvoice.set(invoiceId, [event]);
      }
    },

    async listByInvoice(invoiceId: string, options?: { after?: string }) {
      const events = eventsByInvoice.get(invoiceId) ?? [];
      if (options?.after === undefined) {
        return events;
      }
      const idx = events.findIndex((e) => e.id === options.after);
      if (idx === -1) {
        return events;
      }
      return events.slice(idx + 1);
    },
  };
}
