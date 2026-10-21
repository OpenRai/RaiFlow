import type { EventStore, InvoiceStore, LegacyEventStore, LegacyInvoiceStore, LegacyPayment, PaymentStore } from '@openrai/model';
export declare function createLegacySqliteInvoiceStore(store: InvoiceStore): LegacyInvoiceStore;
export declare function createLegacySqlitePaymentStore(store: PaymentStore, invoiceStore: InvoiceStore): {
    create(payment: LegacyPayment): Promise<LegacyPayment>;
    get(id: string): Promise<LegacyPayment | undefined>;
    getByBlockHash(hash: string): Promise<LegacyPayment | undefined>;
    listByInvoice(invoiceId: string): Promise<LegacyPayment[]>;
};
export declare function createLegacySqliteEventStore(store: EventStore): LegacyEventStore;
