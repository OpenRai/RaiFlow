const LEGACY_EXPIRED_AT_KEY = '__legacyExpiredAt';
function stringifyMetadataValue(value) {
    if (typeof value === 'string')
        return value;
    return JSON.stringify(value);
}
function mapLegacyMetadataToV2(metadata, expiredAt) {
    const out = {};
    if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
            out[key] = stringifyMetadataValue(value);
        }
    }
    if (expiredAt) {
        out[LEGACY_EXPIRED_AT_KEY] = expiredAt;
    }
    return Object.keys(out).length > 0 ? out : null;
}
function mapV2MetadataToLegacy(metadata) {
    if (!metadata)
        return {};
    const { [LEGACY_EXPIRED_AT_KEY]: expiredAt, ...rest } = metadata;
    const result = { ...rest };
    return {
        metadata: Object.keys(result).length > 0 ? result : undefined,
        expiredAt,
    };
}
function toV2Invoice(invoice, idempotencyKey) {
    return {
        id: invoice.id,
        accountKey: invoice.accountKey ?? '',
        invoiceKey: invoice.invoiceKey ?? null,
        status: invoice.status,
        payAddress: invoice.recipientAccount,
        expectedAmountRaw: invoice.expectedAmountRaw,
        receivedAmountRaw: invoice.confirmedAmountRaw,
        memo: null,
        metadata: mapLegacyMetadataToV2(invoice.metadata, invoice.expiredAt),
        idempotencyKey: idempotencyKey ?? null,
        expiresAt: invoice.expiresAt ?? null,
        completedAt: invoice.completedAt ?? null,
        canceledAt: invoice.canceledAt ?? null,
        createdAt: invoice.createdAt,
        updatedAt: invoice.createdAt,
        completionPolicy: invoice.completionPolicy ?? { type: 'at_least' },
        derivationIndex: invoice.derivationIndex ?? null,
    };
}
function toLegacyInvoice(invoice) {
    const legacyMeta = mapV2MetadataToLegacy(invoice.metadata);
    return {
        id: invoice.id,
        status: invoice.status,
        currency: 'XNO',
        expectedAmountRaw: invoice.expectedAmountRaw,
        confirmedAmountRaw: invoice.receivedAmountRaw,
        recipientAccount: invoice.payAddress,
        accountKey: invoice.accountKey ?? undefined,
        invoiceKey: invoice.invoiceKey ?? undefined,
        createdAt: invoice.createdAt,
        expiresAt: invoice.expiresAt ?? undefined,
        completedAt: invoice.completedAt ?? undefined,
        canceledAt: invoice.canceledAt ?? undefined,
        expiredAt: legacyMeta.expiredAt,
        metadata: legacyMeta.metadata,
        completionPolicy: invoice.completionPolicy,
        derivationIndex: invoice.derivationIndex ?? undefined,
    };
}
export function createLegacySqliteInvoiceStore(store) {
    return {
        async create(invoice, idempotencyKey) {
            const created = await store.create(toV2Invoice(invoice, idempotencyKey), idempotencyKey);
            return toLegacyInvoice(created);
        },
        async get(id) {
            const invoice = await store.get(id);
            return invoice ? toLegacyInvoice(invoice) : undefined;
        },
        async getByAccountKeyAndInvoiceKey(accountKey, invoiceKey) {
            const invoice = await store.getByAccountKeyAndInvoiceKey(accountKey, invoiceKey);
            return invoice ? toLegacyInvoice(invoice) : undefined;
        },
        async list(filter) {
            const invoices = await store.list(filter);
            return invoices.map(toLegacyInvoice);
        },
        async update(id, patch) {
            const existing = await store.get(id);
            if (!existing)
                throw new Error(`Invoice ${id} not found`);
            const merged = { ...toLegacyInvoice(existing), ...patch };
            const updated = await store.update(id, {
                status: merged.status,
                payAddress: merged.recipientAccount,
                expectedAmountRaw: merged.expectedAmountRaw,
                receivedAmountRaw: merged.confirmedAmountRaw,
                metadata: mapLegacyMetadataToV2(merged.metadata, merged.expiredAt),
                expiresAt: merged.expiresAt ?? null,
                completedAt: merged.completedAt ?? null,
                canceledAt: merged.canceledAt ?? null,
                completionPolicy: merged.completionPolicy ?? existing.completionPolicy,
            });
            return toLegacyInvoice(updated);
        },
        async getByRecipientAccount(account, status) {
            const invoices = await store.getByPayAddress(account, status);
            return invoices.map(toLegacyInvoice);
        },
        async getByIdempotencyKey(key) {
            return store.getByIdempotencyKey(key);
        },
    };
}
async function hydrateLegacyPayment(payment, invoiceStore) {
    const invoice = await invoiceStore.get(payment.invoiceId);
    return {
        id: payment.id,
        invoiceId: payment.invoiceId,
        status: payment.status,
        currency: 'XNO',
        amountRaw: payment.amountRaw,
        recipientAccount: invoice?.payAddress ?? '',
        senderAccount: payment.senderAddress ?? undefined,
        sendBlockHash: payment.blockHash,
        confirmedAt: payment.confirmedAt ?? payment.detectedAt,
    };
}
export function createLegacySqlitePaymentStore(store, invoiceStore) {
    return {
        async create(payment) {
            const created = await store.create({
                id: payment.id,
                invoiceId: payment.invoiceId,
                status: payment.status,
                blockHash: payment.sendBlockHash,
                senderAddress: payment.senderAccount ?? null,
                amountRaw: payment.amountRaw,
                confirmedAt: payment.confirmedAt,
                detectedAt: payment.confirmedAt,
            });
            return hydrateLegacyPayment(created, invoiceStore);
        },
        async get(id) {
            const payment = await store.get(id);
            return payment ? hydrateLegacyPayment(payment, invoiceStore) : undefined;
        },
        async getByBlockHash(hash) {
            const payment = await store.getByBlockHash(hash);
            return payment ? hydrateLegacyPayment(payment, invoiceStore) : undefined;
        },
        async listByInvoice(invoiceId) {
            const payments = await store.listByInvoice(invoiceId);
            return Promise.all(payments.map((payment) => hydrateLegacyPayment(payment, invoiceStore)));
        },
    };
}
function legacyEventResourceId(event) {
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
export function createLegacySqliteEventStore(store) {
    return {
        async append(event) {
            await store.append({
                id: event.id,
                type: event.type,
                timestamp: event.createdAt,
                data: event.data,
                resourceId: legacyEventResourceId(event),
                resourceType: 'invoice',
            });
        },
        async listByInvoice(invoiceId, options) {
            const events = await store.list({
                resourceType: 'invoice',
                resourceId: invoiceId,
                limit: 1000,
            });
            const mapped = events.map((event) => ({
                id: event.id,
                type: event.type,
                createdAt: event.timestamp,
                data: event.data,
            }));
            if (!options?.after)
                return mapped;
            const index = mapped.findIndex((event) => event.id === options.after);
            return index >= 0 ? mapped.slice(index + 1) : mapped;
        },
    };
}
//# sourceMappingURL=sqlite-legacy-adapters.js.map