// @openrai/model
// Canonical shared types and schemas for RaiFlow

/**
 * Canonical RaiFlow event model (minimal, Nano-native).
 *
 * This model is intentionally small.
 *
 * For the mainline Nano payment-proof story, a confirmed matching send block
 * is the first business-significant payment event. We therefore avoid
 * canonizing extra intermediate payment states unless they are proven necessary.
 *
 * The model may be extended later for advanced observability or custodial modes,
 * but doing so too early risks introducing distinctions that Nano itself does
 * not really require for normal invoice collection flows.
 */

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export type InvoiceStatus =
  | 'open'
  | 'completed'
  | 'expired'
  | 'canceled';

export type PaymentStatus =
  | 'confirmed';

export type CompletionPolicy =
  | { type: 'at_least' }    // default — >= expectedAmountRaw
  | { type: 'exact' };       // === expectedAmountRaw

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface Invoice {
  id: string;
  status: InvoiceStatus;

  currency: 'XNO';
  expectedAmountRaw: string;
  confirmedAmountRaw: string;

  recipientAccount: string;

  createdAt: string;
  expiresAt?: string;
  completedAt?: string;
  expiredAt?: string;
  canceledAt?: string;

  metadata?: Record<string, unknown>;

  completionPolicy?: CompletionPolicy; // default: { type: 'at_least' }
}

export interface Payment {
  id: string;
  invoiceId: string;

  status: PaymentStatus;

  currency: 'XNO';
  amountRaw: string;

  recipientAccount: string;
  senderAccount?: string;

  sendBlockHash: string;
  confirmedAt: string;

  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type RaiFlowEventType =
  | 'invoice.created'
  | 'payment.confirmed'
  | 'invoice.completed'
  | 'invoice.expired'
  | 'invoice.canceled';

export interface EventEnvelope<TType extends RaiFlowEventType, TData> {
  id: string;
  type: TType;
  createdAt: string;
  data: TData;
}

export type InvoiceCreatedEvent = EventEnvelope<
  'invoice.created',
  { invoice: Invoice }
>;

export type PaymentConfirmedEvent = EventEnvelope<
  'payment.confirmed',
  { payment: Payment; invoice: Invoice }
>;

export type InvoiceCompletedEvent = EventEnvelope<
  'invoice.completed',
  { invoice: Invoice }
>;

export type InvoiceExpiredEvent = EventEnvelope<
  'invoice.expired',
  { invoice: Invoice }
>;

export type InvoiceCanceledEvent = EventEnvelope<
  'invoice.canceled',
  { invoice: Invoice }
>;

export type RaiFlowEvent =
  | InvoiceCreatedEvent
  | PaymentConfirmedEvent
  | InvoiceCompletedEvent
  | InvoiceExpiredEvent
  | InvoiceCanceledEvent;

// ---------------------------------------------------------------------------
// Watcher → Runtime contract
// ---------------------------------------------------------------------------

/** A confirmed send block observed by the watcher. */
export interface ConfirmedBlock {
  /** The block hash of the confirmed send. */
  blockHash: string;
  /** The sender's Nano account. */
  senderAccount: string;
  /** The recipient's Nano account. */
  recipientAccount: string;
  /** Amount transferred in raw. */
  amountRaw: string;
  /** ISO-8601 timestamp of confirmation. */
  confirmedAt: string;
}

/** Sink interface that the runtime implements to receive watcher observations. */
export interface WatcherSink {
  handleConfirmedBlock(block: ConfirmedBlock): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface InvoiceStore {
  create(invoice: Invoice, idempotencyKey?: string): Promise<Invoice>;
  get(id: string): Promise<Invoice | undefined>;
  list(filter?: { status?: InvoiceStatus }): Promise<Invoice[]>;
  update(id: string, patch: Partial<Invoice>): Promise<Invoice>;
  getByRecipientAccount(
    account: string,
    status?: InvoiceStatus,
  ): Promise<Invoice[]>;
  /** Resolve an idempotency key to an existing invoice id, if any. */
  getByIdempotencyKey(key: string): Promise<string | undefined>;
}

export interface PaymentStore {
  create(payment: Payment): Promise<Payment>;
  get(id: string): Promise<Payment | undefined>;
  getByBlockHash(hash: string): Promise<Payment | undefined>;
  listByInvoice(invoiceId: string): Promise<Payment[]>;
}

export interface EventStore {
  append(event: RaiFlowEvent): Promise<void>;
  listByInvoice(invoiceId: string, options?: { after?: string }): Promise<RaiFlowEvent[]>;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  eventTypes: RaiFlowEventType[];
  createdAt: string;
}
