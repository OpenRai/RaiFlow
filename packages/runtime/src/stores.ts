// @openrai/runtime — In-memory store implementations

import type {
  Invoice,
  InvoiceStatus,
  InvoiceStore,
  Payment,
  PaymentStore,
  EventStore,
  RaiFlowEvent,
} from '@openrai/model';

// ---------------------------------------------------------------------------
// InvoiceStore
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `InvoiceStore`.
 */
export function createInvoiceStore(): InvoiceStore {
  const invoices = new Map<string, Invoice>();
  const idempotencyKeys = new Map<string, string>(); // key → invoiceId

  return {
    async create(invoice, idempotencyKey) {
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
      return invoices.get(id);
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
      const updated: Invoice = { ...existing, ...patch };
      invoices.set(id, updated);
      return updated;
    },

    async getByRecipientAccount(account, status) {
      const all = Array.from(invoices.values());
      return all.filter(
        (inv) =>
          inv.recipientAccount === account &&
          (status === undefined || inv.status === status),
      );
    },

    async getByIdempotencyKey(key) {
      return idempotencyKeys.get(key);
    },
  };
}

// ---------------------------------------------------------------------------
// PaymentStore
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `PaymentStore`.
 */
export function createPaymentStore(): PaymentStore {
  const payments = new Map<string, Payment>();
  const byBlockHash = new Map<string, string>(); // blockHash → paymentId

  return {
    async create(payment) {
      payments.set(payment.id, payment);
      byBlockHash.set(payment.sendBlockHash, payment.id);
      return payment;
    },

    async get(id) {
      return payments.get(id);
    },

    async getByBlockHash(hash) {
      const id = byBlockHash.get(hash);
      if (id === undefined) return undefined;
      return payments.get(id);
    },

    async listByInvoice(invoiceId) {
      return Array.from(payments.values()).filter(
        (p) => p.invoiceId === invoiceId,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

/**
 * Extract the invoiceId from any RaiFlowEvent (all events contain an invoice).
 */
function extractInvoiceId(event: RaiFlowEvent): string {
  switch (event.type) {
    case 'invoice.created':
    case 'invoice.completed':
    case 'invoice.expired':
    case 'invoice.canceled':
      return event.data.invoice.id;
    case 'payment.confirmed':
      return event.data.invoice.id;
  }
}

/**
 * Create an in-memory `EventStore`.
 */
export function createEventStore(): EventStore {
  const eventsByInvoice = new Map<string, RaiFlowEvent[]>();

  return {
    async append(event) {
      const invoiceId = extractInvoiceId(event);
      const existing = eventsByInvoice.get(invoiceId);
      if (existing !== undefined) {
        existing.push(event);
      } else {
        eventsByInvoice.set(invoiceId, [event]);
      }
    },

    async listByInvoice(invoiceId, options) {
      const events = eventsByInvoice.get(invoiceId) ?? [];
      if (options?.after === undefined) {
        return events;
      }
      // Find the event with the given id and return events after it
      const idx = events.findIndex((e) => e.id === options.after);
      if (idx === -1) {
        return events; // cursor not found, return all
      }
      return events.slice(idx + 1);
    },
  };
}
