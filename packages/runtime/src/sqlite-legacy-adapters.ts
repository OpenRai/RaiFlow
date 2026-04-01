import type {
  EventStore,
  Invoice,
  InvoiceStore,
  LegacyEventStore,
  LegacyInvoice,
  LegacyInvoiceStore,
  LegacyPayment,
  LegacyRaiFlowEvent,
  Payment,
  PaymentStore,
} from '@openrai/model';

const LEGACY_EXPIRED_AT_KEY = '__legacyExpiredAt';

function stringifyMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function mapLegacyMetadataToV2(
  metadata: Record<string, unknown> | undefined,
  expiredAt?: string,
): Record<string, string> | null {
  const out: Record<string, string> = {};

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

function mapV2MetadataToLegacy(
  metadata: Record<string, string> | null,
): { metadata?: Record<string, unknown>; expiredAt?: string } {
  if (!metadata) return {};

  const { [LEGACY_EXPIRED_AT_KEY]: expiredAt, ...rest } = metadata;
  const result: Record<string, unknown> = { ...rest };

  return {
    metadata: Object.keys(result).length > 0 ? result : undefined,
    expiredAt,
  };
}

function toV2Invoice(invoice: LegacyInvoice, idempotencyKey?: string): Invoice {
  return {
    id: invoice.id,
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
  };
}

function toLegacyInvoice(invoice: Invoice): LegacyInvoice {
  const legacyMeta = mapV2MetadataToLegacy(invoice.metadata);

  return {
    id: invoice.id,
    status: invoice.status,
    currency: 'XNO',
    expectedAmountRaw: invoice.expectedAmountRaw,
    confirmedAmountRaw: invoice.receivedAmountRaw,
    recipientAccount: invoice.payAddress,
    createdAt: invoice.createdAt,
    expiresAt: invoice.expiresAt ?? undefined,
    completedAt: invoice.completedAt ?? undefined,
    canceledAt: invoice.canceledAt ?? undefined,
    expiredAt: legacyMeta.expiredAt,
    metadata: legacyMeta.metadata,
    completionPolicy: invoice.completionPolicy,
  };
}

export function createLegacySqliteInvoiceStore(store: InvoiceStore): LegacyInvoiceStore {
  return {
    async create(invoice: LegacyInvoice, idempotencyKey?: string): Promise<LegacyInvoice> {
      const created = await store.create(toV2Invoice(invoice, idempotencyKey), idempotencyKey);
      return toLegacyInvoice(created);
    },

    async get(id: string): Promise<LegacyInvoice | undefined> {
      const invoice = await store.get(id);
      return invoice ? toLegacyInvoice(invoice) : undefined;
    },

    async list(filter?: { status?: LegacyInvoice['status'] }): Promise<LegacyInvoice[]> {
      const invoices = await store.list(filter);
      return invoices.map(toLegacyInvoice);
    },

    async update(id: string, patch: Partial<LegacyInvoice>): Promise<LegacyInvoice> {
      const existing = await store.get(id);
      if (!existing) throw new Error(`Invoice ${id} not found`);

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

    async getByRecipientAccount(
      account: string,
      status?: LegacyInvoice['status'],
    ): Promise<LegacyInvoice[]> {
      const invoices = await store.getByPayAddress(account, status);
      return invoices.map(toLegacyInvoice);
    },

    async getByIdempotencyKey(key: string): Promise<string | undefined> {
      return store.getByIdempotencyKey(key);
    },
  };
}

async function hydrateLegacyPayment(
  payment: Payment,
  invoiceStore: InvoiceStore,
): Promise<LegacyPayment> {
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

export function createLegacySqlitePaymentStore(
  store: PaymentStore,
  invoiceStore: InvoiceStore,
): {
  create(payment: LegacyPayment): Promise<LegacyPayment>;
  get(id: string): Promise<LegacyPayment | undefined>;
  getByBlockHash(hash: string): Promise<LegacyPayment | undefined>;
  listByInvoice(invoiceId: string): Promise<LegacyPayment[]>;
} {
  return {
    async create(payment: LegacyPayment): Promise<LegacyPayment> {
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

    async get(id: string): Promise<LegacyPayment | undefined> {
      const payment = await store.get(id);
      return payment ? hydrateLegacyPayment(payment, invoiceStore) : undefined;
    },

    async getByBlockHash(hash: string): Promise<LegacyPayment | undefined> {
      const payment = await store.getByBlockHash(hash);
      return payment ? hydrateLegacyPayment(payment, invoiceStore) : undefined;
    },

    async listByInvoice(invoiceId: string): Promise<LegacyPayment[]> {
      const payments = await store.listByInvoice(invoiceId);
      return Promise.all(payments.map((payment) => hydrateLegacyPayment(payment, invoiceStore)));
    },
  };
}

function legacyEventResourceId(event: LegacyRaiFlowEvent): string {
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

export function createLegacySqliteEventStore(store: EventStore): LegacyEventStore {
  return {
    async append(event: LegacyRaiFlowEvent): Promise<void> {
      await store.append({
        id: event.id,
        type: event.type,
        timestamp: event.createdAt,
        data: event.data as Record<string, unknown>,
        resourceId: legacyEventResourceId(event),
        resourceType: 'invoice',
      });
    },

    async listByInvoice(
      invoiceId: string,
      options?: { after?: string },
    ): Promise<LegacyRaiFlowEvent[]> {
      const events = await store.list({
        resourceType: 'invoice',
        resourceId: invoiceId,
        limit: 1000,
      });

      const mapped = events.map((event) => ({
        id: event.id,
        type: event.type as LegacyRaiFlowEvent['type'],
        createdAt: event.timestamp,
        data: event.data,
      })) as LegacyRaiFlowEvent[];

      if (!options?.after) return mapped;
      const index = mapped.findIndex((event) => event.id === options.after);
      return index >= 0 ? mapped.slice(index + 1) : mapped;
    },
  };
}
