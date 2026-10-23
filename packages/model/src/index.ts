/// <reference lib="dom" />
// @openrai/model — Canonical shared types and schemas for RaiFlow v2

import { blake2b } from '@noble/hashes/blake2b';

export const INVOICE_DERIVATION_START = 0;
export const MANAGED_DERIVATION_START = 2 ** 31;

export function deriveManagedIndex(accountKey: string): number {
  const hash = blake2b(new TextEncoder().encode(accountKey), { dkLen: 32 });
  const uint32 = ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
  return MANAGED_DERIVATION_START + (uint32 % (2 ** 31));
}

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

export type DepositDisposition = 'matched' | 'partial' | 'excess' | 'late' | 'unmatched';

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface Invoice {
  id: string;
  accountKey: string;
  invoiceKey: string | null;
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
  derivationIndex: number | null;
}

export interface InvoiceAccount {
  accountKey: string;
  invoiceKey: string | null;
  derivationIndex: number;
  address: string;
  createdAt: string;
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

/** A confirmed inbound Nano send. Invoice matching is optional and separate. */
export interface Deposit {
  id: string;
  blockHash: string;
  recipientAccount: string;
  senderAccount: string | null;
  amountRaw: string;
  invoiceId: string | null;
  disposition: DepositDisposition;
  confirmedAt: string;
}

/** A refund is linked to one confirmed deposit and its durable outgoing send. */
export interface Refund {
  id: string;
  depositId: string;
  invoiceId: string | null;
  sendId: string;
  destination: string;
  amountRaw: string;
  status: SendStatus;
  idempotencyKey: string;
  createdAt: string;
  publishedAt: string | null;
  confirmedAt: string | null;
}

export interface Account {
  id: string;
  accountKey: string | null;
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
  source:
    | { type: 'account'; accountId: string; address: string; derivationIndex: number | null }
    | { type: 'invoice'; invoiceId: string; address: string; derivationIndex: number };
  destination: string;
  amountRaw: string;
  status: SendStatus;
  blockHash: string | null;
  idempotencyKey: string;
  createdAt: string;
  publishedAt: string | null;
  confirmedAt: string | null;
}

export type ReceiveTaskStatus = 'pending' | 'processing' | 'published' | 'confirmed' | 'failed';

export interface ReceiveTask {
  id: string;
  accountAddress: string;
  derivationIndex: number;
  pendingBlockHash: string;
  amountRaw: string;
  status: ReceiveTaskStatus;
  /** Hash of RaiFlow's own receive/open block, once published. */
  receiveBlockHash?: string | null;
  createdAt: string;
  publishedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  failReason: string | null;
  retryCount: number;
}

export interface Receivable {
  hash: string;
  amount: string;
  sender: string;
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
  | 'deposit.observed'
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
  | 'receive.published'
  | 'receive.confirmed'
  | 'receive.failed'
  | 'rpc.connected'
  | 'rpc.disconnected'
  | 'rpc.failover';

export interface RaiFlowEvent {
  /** Monotonic persisted cursor. Absent only before an event is stored. */
  sequence?: number;
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  resourceId: string;
  resourceType: 'invoice' | 'payment' | 'deposit' | 'account' | 'send' | 'block' | 'rpc';
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
// Account Event System (real-time streaming)
// ---------------------------------------------------------------------------

export type AccountEventType =
  | 'account.state_synced'
  | 'account.payment_received'
  | 'account.balance_updated'
  | 'account.frontier_updated';

export interface AccountEvent {
  id: string;
  type: AccountEventType;
  accountId: string;
  accountAddress: string;
  timestamp: string;
  data: {
    blockHash?: string;
    senderAccount?: string;
    amountRaw?: string;
    previousBalanceRaw?: string;
    newBalanceRaw?: string;
    previousFrontier?: string | null;
    newFrontier?: string | null;
    snapshot?: {
      balanceRaw: string;
      frontier: string | null;
      representative: string | null;
      blockCount: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Request / Response DTOs
// ---------------------------------------------------------------------------

interface CreateInvoiceRequestFields {
  accountKey: string;
  invoiceKey?: string;
  /** Optional metadata values are strings so the wire shape matches Invoice. */
  metadata?: Record<string, string>;
  expiresAt?: string;
  completionPolicy?: CompletionPolicy;
}

/**
 * Invoice amounts must be sent as an exact decimal string with an explicit
 * unit. Supplying both representations is invalid.
 */
export type CreateInvoiceRequest = CreateInvoiceRequestFields & (
  | { expectedAmountRaw: string; expectedAmount?: never }
  | { expectedAmount: string; expectedAmountRaw?: never }
);

export interface CreateAccountRequest {
  accountKey: string;
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

export interface IdempotencyRecord {
  key: string;
  scope: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Store Interfaces
// ---------------------------------------------------------------------------

export interface InvoiceStore {
  create(invoice: Invoice, idempotencyKey?: string): Promise<Invoice>;
  get(id: string): Promise<Invoice | undefined>;
  /** Resolve one invoice by its durable application identity. */
  getByAccountKeyAndInvoiceKey(accountKey: string, invoiceKey: string | null): Promise<Invoice | undefined>;
  list(filter?: { status?: InvoiceStatus }): Promise<Invoice[]>;
  listByAccountKey(accountKey: string): Promise<Invoice[]>;
  update(id: string, patch: Partial<Invoice>): Promise<Invoice>;
  transition(id: string, expectedStatus: InvoiceStatus, patch: Partial<Invoice>): Promise<Invoice | undefined>;
  getByPayAddress(address: string, status?: InvoiceStatus): Promise<Invoice[]>;
  getByIdempotencyKey(key: string): Promise<string | undefined>;
}

export interface InvoiceAccountStore {
  getOrCreate(
    accountKey: string,
    invoiceKey: string | null,
    derivationStartIndex: number,
    derivationEndIndex: number,
    deriveAddress: (index: number) => string,
  ): Promise<InvoiceAccount>;
  get(accountKey: string, invoiceKey: string | null): Promise<InvoiceAccount | undefined>;
  listByAccountKey(accountKey: string): Promise<InvoiceAccount[]>;
}

export interface PaymentStore {
  create(payment: Payment): Promise<Payment>;
  get(id: string): Promise<Payment | undefined>;
  getByBlockHash(hash: string): Promise<Payment | undefined>;
  listByInvoice(invoiceId: string): Promise<Payment[]>;
}

export interface DepositStore {
  /** Persist once per confirmed source-send hash, returning the canonical row on replay. */
  createIfAbsent(deposit: Deposit): Promise<Deposit>;
  getByBlockHash(hash: string): Promise<Deposit | undefined>;
  /** Optional convenience lookup by deposit resource ID. */
  get?(id: string): Promise<Deposit | undefined>;
  listByRecipientAccounts(addresses: string[]): Promise<Deposit[]>;
}

export interface RefundQueueResult {
  refund: Refund;
  send: Send;
  created: boolean;
}

/** Atomically reserves a deposit amount and persists the linked durable send. */
export interface RefundStore {
  queue(deposit: Deposit, refund: Refund, send: Send): Promise<RefundQueueResult>;
  listByDepositId(depositId: string): Promise<Refund[]>;
}

export interface AccountStore {
  create(account: Account): Promise<Account>;
  get(id: string): Promise<Account | undefined>;
  getByAddress(address: string): Promise<Account | undefined>;
  list(filter?: { type?: AccountType }): Promise<Account[]>;
  update(id: string, patch: Partial<Account>): Promise<Account>;
  delete(id: string): Promise<boolean>;
}

export interface SendStore {
  create(send: Send): Promise<Send>;
  get(id: string): Promise<Send | undefined>;
  getByBlockHash(hash: string): Promise<Send | undefined>;
  listByAccount(accountId: string): Promise<Send[]>;
  listByStatus(status: SendStatus): Promise<Send[]>;
  getByIdempotencyKey(key: string): Promise<Send | undefined>;
  update(id: string, patch: Partial<Send>): Promise<Send>;
}

export interface ReceiveTaskStore {
  create(task: Omit<ReceiveTask, 'id' | 'createdAt'>): Promise<ReceiveTask>;
  get(id: string): Promise<ReceiveTask | undefined>;
  getByPendingBlockHash(hash: string): Promise<ReceiveTask | undefined>;
  listByStatus(status: ReceiveTaskStatus): Promise<ReceiveTask[]>;
  update(id: string, patch: Partial<ReceiveTask>): Promise<ReceiveTask>;
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

export interface IdempotencyReplayStore {
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  put(scope: string, key: string, resourceType: string, resourceId: string): Promise<IdempotencyRecord>;
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
  /** True when account-history reconciliation found this send was already received. */
  alreadyReceived?: boolean;
}

export interface WatcherSink {
  handleConfirmedBlock(block: ConfirmedBlock): Promise<void>;
}

export interface CustodyEngine {
  generateWork(hash: string): Promise<string>;
  generateReceiveWork(hash: string): Promise<string>;
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
