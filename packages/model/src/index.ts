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

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface Invoice {
  id: string;
  status: InvoiceStatus;

  currency: 'XNO';
  expectedAmountRaw: string;
  confirmedAmountRaw: string;

  createdAt: string;
  expiresAt?: string;
  completedAt?: string;
  expiredAt?: string;
  canceledAt?: string;

  metadata?: Record<string, unknown>;
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
// Webhook
// ---------------------------------------------------------------------------

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  eventTypes: RaiFlowEventType[];
  createdAt: string;
}
