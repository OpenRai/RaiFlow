// @openrai/runtime — In-memory store implementations (prototype-era)
// These stores use the legacy model shapes. Will be replaced with SQLite-backed
// implementations using the v2 model in Slice B4.
// ---------------------------------------------------------------------------
// InvoiceStore (prototype-era)
// ---------------------------------------------------------------------------
/**
 * Create an in-memory `InvoiceStore` using the prototype-era Invoice shape.
 */
export function createInvoiceStore() {
    const invoices = new Map();
    const idempotencyKeys = new Map();
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
        async getByAccountKeyAndInvoiceKey(accountKey, invoiceKey) {
            return Array.from(invoices.values()).find((invoice) => invoice.accountKey === accountKey && (invoice.invoiceKey ?? null) === invoiceKey);
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
            const updated = { ...existing, ...patch };
            invoices.set(id, updated);
            return updated;
        },
        async getByRecipientAccount(account, status) {
            const all = Array.from(invoices.values());
            return all.filter((inv) => inv.recipientAccount === account &&
                (status === undefined || inv.status === status));
        },
        async getByIdempotencyKey(key) {
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
export function createPaymentStore() {
    const payments = new Map();
    const byBlockHash = new Map();
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
            if (id === undefined)
                return undefined;
            return payments.get(id);
        },
        async listByInvoice(invoiceId) {
            return Array.from(payments.values()).filter((p) => p.invoiceId === invoiceId);
        },
    };
}
// ---------------------------------------------------------------------------
// EventStore (prototype-era)
// ---------------------------------------------------------------------------
/**
 * Extract the invoiceId from a legacy event.
 */
function extractInvoiceId(event) {
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
 * Create an in-memory `EventStore` using the prototype-era event shape.
 */
export function createEventStore() {
    const eventsByInvoice = new Map();
    return {
        async append(event) {
            const invoiceId = extractInvoiceId(event);
            const existing = eventsByInvoice.get(invoiceId);
            if (existing !== undefined) {
                existing.push(event);
            }
            else {
                eventsByInvoice.set(invoiceId, [event]);
            }
        },
        async listByInvoice(invoiceId, options) {
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
export function createIdempotencyReplayStore() {
    const records = new Map();
    function scoped(scope, key) {
        return `${scope}:${key}`;
    }
    return {
        async get(scope, key) {
            return records.get(scoped(scope, key));
        },
        async put(scope, key, resourceType, resourceId) {
            const storeKey = scoped(scope, key);
            const existing = records.get(storeKey);
            if (existing)
                return existing;
            const created = {
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
//# sourceMappingURL=stores.js.map