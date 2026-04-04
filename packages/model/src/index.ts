// @openrai/model — Canonical shared types and schemas for RaiFlow v2

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export type InvoiceStatus =
  | 'open'
  | 'completed'
  | 'expired'
  | 'canceled';

export type PaymentStatus =
  | 'pending'
  | 'confirmed'
  | 'failed';

export type AccountType =
  | 'managed'
  | 'watched';

export type SendStatus =
  | 'queued'
  | 'published'
  | 'confirmed'
  | 'failed';

export type CompletionPolicy =
  | { type: 'at_least' }
  | { type: 'exact' };

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface Invoice {
  id: string;
  status: InvoiceStatus;
  payAddress: string;
  expectedAmountRaw: string;
  receivedAmountRaw: string;
  memo: string | null;
  metadata: Record<string, string> | null;
  idempotencyKey: string | null;
  expiresAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
  completionPolicy: CompletionPolicy;
}

export interface Payment {
  id: string;
  invoiceId: string;
  status: PaymentStatus;
  blockHash: string;
  senderAddress: string | null;
  amountRaw: string;
  confirmedAt: string | null;
  detectedAt: string;
}

export interface Account {
  id: string;
  type: AccountType;
  address: string;
  label: string | null;
  balanceRaw: string;
  pendingRaw: string;
  frontier: string | null;
  representative: string | null;
  derivationIndex: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Send {
  id: string;
  accountId: string;
  destination: string;
  amountRaw: string;
  status: SendStatus;
  blockHash: string | null;
  idempotencyKey: string;
  createdAt: string;
  publishedAt: string | null;
  confirmedAt: string | null;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Event System
// ---------------------------------------------------------------------------

export type RaiFlowEventType =
  | 'invoice.created'
  | 'invoice.payment_received'
  | 'invoice.payment_confirmed'
  | 'invoice.completed'
  | 'invoice.expired'
  | 'invoice.canceled'
  | 'invoice.swept'
  | 'account.created'
  | 'account.received'
  | 'account.balance_updated'
  | 'account.removed'
  | 'send.queued'
  | 'send.published'
  | 'send.confirmed'
  | 'send.failed'
  | 'block.published'
  | 'block.confirmed'
  | 'block.failed'
  | 'rpc.connected'
  | 'rpc.disconnected'
  | 'rpc.failover';

export interface RaiFlowEvent {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  resourceId: string;
  resourceType: 'invoice' | 'payment' | 'account' | 'send' | 'block' | 'rpc';
}

export interface InvoiceCreatedEvent extends RaiFlowEvent {
  type: 'invoice.created';
  data: { invoice: Invoice };
  resourceId: string;
  resourceType: 'invoice';
}

export interface InvoicePaymentReceivedEvent extends RaiFlowEvent {
  type: 'invoice.payment_received';
  data: { payment: Payment; invoice: Invoice };
  resourceId: string;
  resourceType: 'payment';
}

export interface InvoicePaymentConfirmedEvent extends RaiFlowEvent {
  type: 'invoice.payment_confirmed';
  data: { payment: Payment; invoice: Invoice };
  resourceId: string;
  resourceType: 'payment';
}

export interface InvoiceCompletedEvent extends RaiFlowEvent {
  type: 'invoice.completed';
  data: { invoice: Invoice };
  resourceId: string;
  resourceType: 'invoice';
}

export interface InvoiceExpiredEvent extends RaiFlowEvent {
  type: 'invoice.expired';
  data: { invoice: Invoice };
  resourceId: string;
  resourceType: 'invoice';
}

export interface InvoiceCanceledEvent extends RaiFlowEvent {
  type: 'invoice.canceled';
  data: { invoice: Invoice };
  resourceId: string;
  resourceType: 'invoice';
}

export interface InvoiceSweptEvent extends RaiFlowEvent {
  type: 'invoice.swept';
  data: { invoice: Invoice; send: Send };
  resourceId: string;
  resourceType: 'invoice';
}

export interface AccountCreatedEvent extends RaiFlowEvent {
  type: 'account.created';
  data: { account: Account };
  resourceId: string;
  resourceType: 'account';
}

export interface AccountReceivedEvent extends RaiFlowEvent {
  type: 'account.received';
  data: { account: Account; payment: Payment };
  resourceId: string;
  resourceType: 'account';
}

export interface AccountBalanceUpdatedEvent extends RaiFlowEvent {
  type: 'account.balance_updated';
  data: { account: Account; previousBalanceRaw: string };
  resourceId: string;
  resourceType: 'account';
}

export interface AccountRemovedEvent extends RaiFlowEvent {
  type: 'account.removed';
  data: { account: Account };
  resourceId: string;
  resourceType: 'account';
}

export interface SendQueuedEvent extends RaiFlowEvent {
  type: 'send.queued';
  data: { send: Send };
  resourceId: string;
  resourceType: 'send';
}

export interface SendPublishedEvent extends RaiFlowEvent {
  type: 'send.published';
  data: { send: Send };
  resourceId: string;
  resourceType: 'send';
}

export interface SendConfirmedEvent extends RaiFlowEvent {
  type: 'send.confirmed';
  data: { send: Send };
  resourceId: string;
  resourceType: 'send';
}

export interface SendFailedEvent extends RaiFlowEvent {
  type: 'send.failed';
  data: { send: Send; reason: string };
  resourceId: string;
  resourceType: 'send';
}

export interface BlockPublishedEvent extends RaiFlowEvent {
  type: 'block.published';
  data: { blockHash: string };
  resourceId: string;
  resourceType: 'block';
}

export interface BlockConfirmedEvent extends RaiFlowEvent {
  type: 'block.confirmed';
  data: { blockHash: string };
  resourceId: string;
  resourceType: 'block';
}

export interface BlockFailedEvent extends RaiFlowEvent {
  type: 'block.failed';
  data: { blockHash: string; reason: string };
  resourceId: string;
  resourceType: 'block';
}

export interface RpcConnectedEvent extends RaiFlowEvent {
  type: 'rpc.connected';
  data: { nodeUrl: string };
  resourceId: string;
  resourceType: 'rpc';
}

export interface RpcDisconnectedEvent extends RaiFlowEvent {
  type: 'rpc.disconnected';
  data: { nodeUrl: string };
  resourceId: string;
  resourceType: 'rpc';
}

export interface RpcFailoverEvent extends RaiFlowEvent {
  type: 'rpc.failover';
  data: { fromUrl: string; toUrl: string };
  resourceId: string;
  resourceType: 'rpc';
}

// ---------------------------------------------------------------------------
// Request / Response DTOs
// ---------------------------------------------------------------------------

export interface CreateInvoiceRequest {
  expectedAmountRaw: string;
  memo?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  expiresIn?: number;
  expiresAt?: string;
  completionPolicy?: CompletionPolicy;
}

export interface CreateAccountRequest {
  label?: string;
  representative?: string;
  idempotencyKey?: string;
}

export interface WatchAccountRequest {
  account: string;
  label?: string;
}

export interface UpdateAccountRequest {
  label?: string;
  representative?: string;
}

export interface SendRequest {
  destination: string;
  amountRaw: string;
  idempotencyKey: string;
}

export interface PublishBlockRequest {
  block: string;
  watchConfirmation?: boolean;
}

export interface WorkGenerateRequest {
  hash: string;
  difficulty?: string;
}

export interface CreateWebhookRequest {
  url: string;
  eventTypes: string[];
  secret?: string;
}

export interface EventQueryOptions {
  after?: string;
  type?: string;
  resourceType?: string;
  resourceId?: string;
  limit?: number;
}

export interface PaginatedEventsResponse {
  data: RaiFlowEvent[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Store Interfaces
// ---------------------------------------------------------------------------

export interface InvoiceStore {
  create(invoice: Invoice, idempotencyKey?: string): Promise<Invoice>;
  get(id: string): Promise<Invoice | undefined>;
  list(filter?: { status?: InvoiceStatus }): Promise<Invoice[]>;
  update(id: string, patch: Partial<Invoice>): Promise<Invoice>;
  getByPayAddress(address: string, status?: InvoiceStatus): Promise<Invoice[]>;
  getByIdempotencyKey(key: string): Promise<string | undefined>;
}

export interface PaymentStore {
  create(payment: Payment): Promise<Payment>;
  get(id: string): Promise<Payment | undefined>;
  getByBlockHash(hash: string): Promise<Payment | undefined>;
  listByInvoice(invoiceId: string): Promise<Payment[]>;
}

export interface AccountStore {
  create(account: Account): Promise<Account>;
  get(id: string): Promise<Account | undefined>;
  getByAddress(address: string): Promise<Account | undefined>;
  list(filter?: { type?: AccountType }): Promise<Account[]>;
  update(id: string, patch: Partial<Account>): Promise<Account>;
}

export interface SendStore {
  create(send: Send): Promise<Send>;
  get(id: string): Promise<Send | undefined>;
  listByAccount(accountId: string): Promise<Send[]>;
  getByIdempotencyKey(key: string): Promise<Send | undefined>;
  update(id: string, patch: Partial<Send>): Promise<Send>;
}

export interface EventStore {
  append(event: RaiFlowEvent): Promise<void>;
  list(options?: EventQueryOptions): Promise<RaiFlowEvent[]>;
}

export interface WebhookEndpointStore {
  create(endpoint: Omit<WebhookEndpoint, 'id' | 'createdAt'> & { secret?: string }): Promise<WebhookEndpoint>;
  get(id: string): Promise<WebhookEndpoint | undefined>;
  list(): Promise<WebhookEndpoint[]>;
  delete(id: string): Promise<boolean>;
  getByEventType(eventType: string): Promise<WebhookEndpoint[]>;
}

// ---------------------------------------------------------------------------
// ConfirmedBlock (from watcher)
// ---------------------------------------------------------------------------

export interface ConfirmedBlock {
  blockHash: string;
  senderAccount: string;
  recipientAccount: string;
  amountRaw: string;
  confirmedAt: string;
}

export interface WatcherSink {
  handleConfirmedBlock(block: ConfirmedBlock): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error Model
// ---------------------------------------------------------------------------

/** Error response shape for HTTP API responses */
export interface RaiFlowErrorResponse {
  error: {
    message: string;
    code: string;
  };
}

export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'internal_error';

export { RaiFlowError, StorageError, CustodyError, isErrorWithCode, getErrorCode } from './errors.js';

// ---------------------------------------------------------------------------
// Backward compatibility aliases (prototype-era)
// These allow the old runtime to keep building while being rewritten.
// Remove when runtime is fully rewritten.
// ---------------------------------------------------------------------------

export type LegacyPaymentStatus = PaymentStatus;

/** Prototype-era Invoice shape. Remove when runtime is rewritten. */
export interface LegacyInvoice {
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
  completionPolicy?: CompletionPolicy;
}

/** Prototype-era Payment shape. Remove when runtime is rewritten. */
export interface LegacyPayment {
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

/** Prototype-era EventEnvelope. Remove when runtime is rewritten. */
export interface LegacyEventEnvelope<TType extends string, TData> {
  id: string;
  type: TType;
  createdAt: string;
  data: TData;
}

/** Prototype-era store interface. Remove when runtime is rewritten. */
export interface LegacyInvoiceStore {
  create(invoice: LegacyInvoice, idempotencyKey?: string): Promise<LegacyInvoice>;
  get(id: string): Promise<LegacyInvoice | undefined>;
  list(filter?: { status?: InvoiceStatus }): Promise<LegacyInvoice[]>;
  update(id: string, patch: Partial<LegacyInvoice>): Promise<LegacyInvoice>;
  getByRecipientAccount(account: string, status?: InvoiceStatus): Promise<LegacyInvoice[]>;
  getByIdempotencyKey(key: string): Promise<string | undefined>;
}

/** Prototype-era PaymentStore. Remove when runtime is rewritten. */
export interface LegacyPaymentStore {
  create(payment: LegacyPayment): Promise<LegacyPayment>;
  get(id: string): Promise<LegacyPayment | undefined>;
  getByBlockHash(hash: string): Promise<LegacyPayment | undefined>;
  listByInvoice(invoiceId: string): Promise<LegacyPayment[]>;
}

/** Prototype-era EventStore. Remove when runtime is rewritten. */
export interface LegacyEventStore {
  append(event: LegacyRaiFlowEvent): Promise<void>;
  listByInvoice(invoiceId: string, options?: { after?: string }): Promise<LegacyRaiFlowEvent[]>;
}

export type LegacyRaiFlowEventType =
  | 'invoice.created'
  | 'payment.confirmed'
  | 'invoice.completed'
  | 'invoice.expired'
  | 'invoice.canceled';

export type LegacyRaiFlowEvent =
  | LegacyInvoiceCreatedEvent
  | LegacyPaymentConfirmedEvent
  | LegacyInvoiceCompletedEvent
  | LegacyInvoiceExpiredEvent
  | LegacyInvoiceCanceledEvent;

export interface LegacyInvoiceCreatedEvent extends LegacyEventEnvelope<'invoice.created', { invoice: LegacyInvoice }> {}
export interface LegacyPaymentConfirmedEvent extends LegacyEventEnvelope<'payment.confirmed', { payment: LegacyPayment; invoice: LegacyInvoice }> {}
export interface LegacyInvoiceCompletedEvent extends LegacyEventEnvelope<'invoice.completed', { invoice: LegacyInvoice }> {}
export interface LegacyInvoiceExpiredEvent extends LegacyEventEnvelope<'invoice.expired', { invoice: LegacyInvoice }> {}
export interface LegacyInvoiceCanceledEvent extends LegacyEventEnvelope<'invoice.canceled', { invoice: LegacyInvoice }> {}
