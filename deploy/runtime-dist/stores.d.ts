import type { IdempotencyReplayStore } from '@openrai/model';
import type { LegacyInvoiceStore, LegacyEventStore, LegacyPayment } from '@openrai/model';
/**
 * Create an in-memory `InvoiceStore` using the prototype-era Invoice shape.
 */
export declare function createInvoiceStore(): LegacyInvoiceStore;
/**
 * Create an in-memory `PaymentStore` using the prototype-era Payment shape.
 */
export declare function createPaymentStore(): LegacyPaymentStore;
export interface LegacyPaymentStore {
    create(payment: LegacyPayment): Promise<LegacyPayment>;
    get(id: string): Promise<LegacyPayment | undefined>;
    getByBlockHash(hash: string): Promise<LegacyPayment | undefined>;
    listByInvoice(invoiceId: string): Promise<LegacyPayment[]>;
}
/**
 * Create an in-memory `EventStore` using the prototype-era event shape.
 */
export declare function createEventStore(): LegacyEventStore;
export declare function createIdempotencyReplayStore(): IdempotencyReplayStore;
