// @openrai/runtime — Runtime core

import { randomUUID } from 'node:crypto';
import type {
  InvoiceStatus,
  RaiFlowEventType,
  WatcherSink,
  ConfirmedBlock,
  CompletionPolicy,
  LegacyInvoice,
  LegacyInvoiceStore,
  LegacyPaymentStore,
  LegacyEventStore,
  LegacyRaiFlowEvent,
  WebhookEndpointStore,
  Account,
  AccountStore,
  AccountType,
  Send,
  SendStore,
  RaiFlowEvent,
  EventStore,
} from '@openrai/model';
import { RaiFlowError } from '@openrai/model';
import { NanoAddress } from '@openrai/nano-core';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import {
  createWebhookDelivery,
  createWebhookEndpointStore,
  type WebhookDelivery,
} from '@openrai/webhook';
import {
  createInvoiceStore,
  createPaymentStore,
  createEventStore,
} from './stores.js';
import { SendOrchestrator } from './send-orchestrator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventListener = (event: LegacyRaiFlowEvent) => void | Promise<void>;

export interface WatcherLike {
  addAccount(account: string): void;
  removeAccount(account: string): void;
}

// ---------------------------------------------------------------------------
// XNO → raw conversion
// ---------------------------------------------------------------------------

const RAW_PER_XNO_EXPONENT = 30;

/**
 * Convert a human-readable XNO amount string to raw (the smallest Nano unit).
 * Uses string manipulation + BigInt to avoid floating-point precision loss.
 *
 * @example xnoToRaw("1")      // "1000000000000000000000000000000"
 * @example xnoToRaw("0.001")  // "1000000000000000000000000000"
 */
export function xnoToRaw(xno: string): string {
  const trimmed = xno.trim();
  if (trimmed === '' || trimmed.startsWith('-')) {
    throw new Error(`Invalid XNO amount: ${xno}`);
  }

  const dotIndex = trimmed.indexOf('.');
  let integerPart: string;
  let fractionalPart: string;

  if (dotIndex === -1) {
    integerPart = trimmed;
    fractionalPart = '';
  } else {
    integerPart = trimmed.slice(0, dotIndex);
    fractionalPart = trimmed.slice(dotIndex + 1);
  }

  if (fractionalPart.length > RAW_PER_XNO_EXPONENT) {
    throw new Error(
      `XNO amount has more than ${RAW_PER_XNO_EXPONENT} decimal places: ${xno}`,
    );
  }

  // Pad fractional part to exactly 30 digits
  const padded = fractionalPart.padEnd(RAW_PER_XNO_EXPONENT, '0');
  const raw = BigInt(integerPart + padded);

  if (raw === 0n) {
    throw new Error(`XNO amount must be greater than zero: ${xno}`);
  }

  return raw.toString();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  invoiceStore?: LegacyInvoiceStore;
  paymentStore?: LegacyPaymentStore;
  eventStore?: LegacyEventStore;
  v2EventStore?: EventStore;
  webhookEndpointStore?: WebhookEndpointStore;
  webhookDelivery?: WebhookDelivery;
  /** Interval in ms for the expiry checker. Default 10000 (10s). */
  expiryIntervalMs?: number;
  accountStore?: AccountStore;
  sendStore?: SendStore;
  custodyEngine?: CustodyEngine;
  rpcPool?: RpcPool;
  watcher?: WatcherLike;
}

/** States that cannot be transitioned out of. */
const TERMINAL_STATES = new Set<InvoiceStatus>(['completed', 'expired', 'canceled']);

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class Runtime implements WatcherSink {
  readonly invoiceStore: LegacyInvoiceStore;
  readonly paymentStore: LegacyPaymentStore;
  readonly eventStore: LegacyEventStore;
  readonly webhookEndpointStore: WebhookEndpointStore;
  readonly accountStore?: AccountStore;
  readonly sendStore?: SendStore;
  readonly custodyEngine?: CustodyEngine;
  readonly rpcPool?: RpcPool;

  private readonly v2EventStore?: EventStore;
  private readonly webhookDelivery: WebhookDelivery;
  private readonly expiryIntervalMs: number;
  private expiryTimer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly sendOrchestrator?: SendOrchestrator;
  watcher?: WatcherLike;

  constructor(config: RuntimeConfig = {}) {
    this.invoiceStore = config.invoiceStore ?? createInvoiceStore();
    this.paymentStore = config.paymentStore ?? createPaymentStore();
    this.eventStore = config.eventStore ?? createEventStore();
    this.v2EventStore = config.v2EventStore;
    this.webhookEndpointStore =
      config.webhookEndpointStore ?? createWebhookEndpointStore();
    this.webhookDelivery = config.webhookDelivery ?? createWebhookDelivery();
    this.expiryIntervalMs = config.expiryIntervalMs ?? 10_000;
    this.accountStore = config.accountStore;
    this.sendStore = config.sendStore;
    this.custodyEngine = config.custodyEngine;
    this.rpcPool = config.rpcPool;
    this.watcher = config.watcher;

    if (this.sendStore && this.accountStore && this.custodyEngine && this.rpcPool) {
      this.sendOrchestrator = new SendOrchestrator(
        this.sendStore,
        this.accountStore,
        this.custodyEngine,
        this.rpcPool,
        (event) => this.emitV2Event(event),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the expiry scheduler and send orchestrator. */
  start(): void {
    if (this.expiryTimer !== undefined) return;
    this.expiryTimer = setInterval(() => {
      void this.runExpiryCheck();
    }, this.expiryIntervalMs);
    // Allow Node.js to exit even if the timer is still running
    if (typeof this.expiryTimer === 'object' && this.expiryTimer !== null && 'unref' in this.expiryTimer) {
      (this.expiryTimer as NodeJS.Timeout).unref();
    }
    this.sendOrchestrator?.start();
  }

  /** Stop the expiry scheduler, send orchestrator, and shut down webhook delivery. */
  stop(): void {
    if (this.expiryTimer !== undefined) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.sendOrchestrator?.stop();
    this.webhookDelivery.shutdown();
  }

  // -------------------------------------------------------------------------
  // Invoice management
  // -------------------------------------------------------------------------

  async createInvoice(
    params: {
      recipientAccount: string;
      /** Amount in raw (string). Provide this or `expectedAmount`. */
      expectedAmountRaw?: string;
      /** Amount in XNO (human-readable). Converted to raw via `xnoToRaw`. */
      expectedAmount?: string;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
      completionPolicy?: CompletionPolicy;
    },
    idempotencyKey?: string,
  ): Promise<LegacyInvoice> {
    const resolvedAmountRaw =
      params.expectedAmountRaw ??
      (params.expectedAmount !== undefined ? xnoToRaw(params.expectedAmount) : undefined);

    if (resolvedAmountRaw === undefined) {
      throw new Error('Either expectedAmountRaw or expectedAmount is required');
    }

    const invoice: LegacyInvoice = {
      id: randomUUID(),
      status: 'open',
      currency: 'XNO',
      expectedAmountRaw: resolvedAmountRaw,
      confirmedAmountRaw: '0',
      recipientAccount: params.recipientAccount,
      createdAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
      metadata: params.metadata,
      completionPolicy: params.completionPolicy ?? { type: 'at_least' },
    };

    const stored = await this.invoiceStore.create(invoice, idempotencyKey);

    // If returned invoice has a different id, the idempotency key was a hit —
    // skip event emission for the deduplicated request.
    if (stored.id !== invoice.id) {
      return stored;
    }

    await this.emitEvent({
      id: randomUUID(),
      type: 'invoice.created',
      createdAt: new Date().toISOString(),
      data: { invoice: stored },
    });

    return stored;
  }

  async getInvoice(id: string): Promise<LegacyInvoice | undefined> {
    return this.invoiceStore.get(id);
  }

  async listInvoices(filter?: { status?: InvoiceStatus }): Promise<LegacyInvoice[]> {
    return this.invoiceStore.list(filter);
  }

  async cancelInvoice(id: string): Promise<LegacyInvoice> {
    const invoice = await this.invoiceStore.get(id);
    if (invoice === undefined) {
      throw RaiFlowError.notFound('Invoice', id);
    }
    if (TERMINAL_STATES.has(invoice.status)) {
      throw RaiFlowError.conflict(
        `Invoice ${id} is already in terminal state: ${invoice.status}`,
      );
    }

    const updated = await this.invoiceStore.update(id, {
      status: 'canceled',
      canceledAt: new Date().toISOString(),
    });

    await this.emitEvent({
      id: randomUUID(),
      type: 'invoice.canceled',
      createdAt: new Date().toISOString(),
      data: { invoice: updated },
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Account management
  // -------------------------------------------------------------------------

  async createManagedAccount(params: {
    label?: string;
    representative?: string;
    idempotencyKey?: string;
  }): Promise<Account> {
    if (!this.custodyEngine) {
      throw RaiFlowError.badRequest('Custody engine not configured');
    }
    if (!this.accountStore) {
      throw RaiFlowError.badRequest( 'Account store not configured');
    }

    const nextIndex = await this.getNextManagedDerivationIndex();
    const address = this.custodyEngine.deriveManagedAccount({ index: nextIndex });

    const account: Account = {
      id: randomUUID(),
      type: 'managed',
      address,
      label: params.label ?? null,
      balanceRaw: '0',
      pendingRaw: '0',
      frontier: null,
      representative: params.representative ?? null,
      derivationIndex: nextIndex,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.accountStore.create(account);
    this.watcher?.addAccount(account.address);

    await this.emitV2Event({
      id: randomUUID(),
      type: 'account.created',
      timestamp: new Date().toISOString(),
      data: { account },
      resourceId: account.id,
      resourceType: 'account',
    });

    return account;
  }

  async createWatchedAccount(params: {
    address: string;
    label?: string;
  }): Promise<Account> {
    if (!this.accountStore) {
      throw RaiFlowError.badRequest( 'Account store not configured');
    }

    // Validate address format
    try {
      NanoAddress.parse(params.address);
    } catch {
      throw RaiFlowError.badRequest( `Invalid Nano address: ${params.address}`);
    }

    // Idempotency by address
    const existing = await this.accountStore.getByAddress(params.address);
    if (existing) {
      return existing;
    }

    const account: Account = {
      id: randomUUID(),
      type: 'watched',
      address: params.address,
      label: params.label ?? null,
      balanceRaw: '0',
      pendingRaw: '0',
      frontier: null,
      representative: null,
      derivationIndex: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.accountStore.create(account);
    this.watcher?.addAccount(account.address);

    await this.emitV2Event({
      id: randomUUID(),
      type: 'account.created',
      timestamp: new Date().toISOString(),
      data: { account },
      resourceId: account.id,
      resourceType: 'account',
    });

    return account;
  }

  async listAccounts(filter?: { type?: AccountType }): Promise<Account[]> {
    if (!this.accountStore) return [];
    return this.accountStore.list(filter);
  }

  async getAccount(id: string): Promise<Account | undefined> {
    if (!this.accountStore) return undefined;
    return this.accountStore.get(id);
  }

  async updateAccount(id: string, patch: { label?: string; representative?: string }): Promise<Account> {
    if (!this.accountStore) {
      throw RaiFlowError.badRequest( 'Account store not configured');
    }
    const existing = await this.accountStore.get(id);
    if (!existing) {
      throw RaiFlowError.notFound('Account', id);
    }
    const updated = await this.accountStore.update(id, patch);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Send management
  // -------------------------------------------------------------------------

  async queueSend(params: {
    accountId: string;
    destination: string;
    amountRaw: string;
    idempotencyKey: string;
  }): Promise<Send> {
    if (!this.accountStore || !this.sendStore) {
      throw RaiFlowError.badRequest( 'Send store not configured');
    }

    // Look up account
    const account = await this.accountStore.get(params.accountId);
    if (!account) {
      throw RaiFlowError.notFound('Account', params.accountId);
    }
    if (account.type !== 'managed') {
      throw RaiFlowError.conflict('Only managed accounts can queue sends');
    }

    // Validate destination address
    try {
      NanoAddress.parse(params.destination);
    } catch {
      throw RaiFlowError.badRequest( `Invalid destination address: ${params.destination}`);
    }

    // Validate amount
    if (!/^\d+$/.test(params.amountRaw) || BigInt(params.amountRaw) <= 0n) {
      throw RaiFlowError.badRequest( 'amountRaw must be a positive numeric string');
    }

    // Check idempotency
    const existing = await this.sendStore.getByIdempotencyKey(params.idempotencyKey);
    if (existing) {
      return existing;
    }

    const send: Send = {
      id: randomUUID(),
      accountId: params.accountId,
      destination: params.destination,
      amountRaw: params.amountRaw,
      status: 'queued',
      blockHash: null,
      idempotencyKey: params.idempotencyKey,
      createdAt: new Date().toISOString(),
      publishedAt: null,
      confirmedAt: null,
    };

    await this.sendStore.create(send);

    await this.emitV2Event({
      id: randomUUID(),
      type: 'send.queued',
      timestamp: new Date().toISOString(),
      data: { send },
      resourceId: send.id,
      resourceType: 'send',
    });

    return send;
  }

  async listSendsByAccount(accountId: string): Promise<Send[]> {
    if (!this.sendStore) return [];
    return this.sendStore.listByAccount(accountId);
  }

  async getSend(id: string): Promise<Send | undefined> {
    if (!this.sendStore) return undefined;
    return this.sendStore.get(id);
  }

  // -------------------------------------------------------------------------
  // Payment / event queries
  // -------------------------------------------------------------------------

  async getPaymentsByInvoice(invoiceId: string) {
    return this.paymentStore.listByInvoice(invoiceId);
  }

  async getEventsByInvoice(invoiceId: string, options?: { after?: string }) {
    return this.eventStore.listByInvoice(invoiceId, options);
  }

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  on(type: RaiFlowEventType | '*', listener: EventListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  off(type: RaiFlowEventType | '*', listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  // -------------------------------------------------------------------------
  // WatcherSink — the core matching logic
  // -------------------------------------------------------------------------

  async handleConfirmedBlock(block: ConfirmedBlock): Promise<void> {
    // --- Send confirmation tracking ---
    if (this.sendStore) {
      const send = await this.sendStore.getByBlockHash(block.blockHash);
      if (send && send.status === 'published') {
        const confirmed = await this.sendStore.update(send.id, {
          status: 'confirmed',
          confirmedAt: block.confirmedAt,
        });

        await this.emitV2Event({
          id: randomUUID(),
          type: 'send.confirmed',
          timestamp: new Date().toISOString(),
          data: { send: confirmed },
          resourceId: confirmed.id,
          resourceType: 'send',
        });
      }
    }

    // --- Account balance update for incoming receives ---
    if (this.accountStore) {
      const account = await this.accountStore.getByAddress(block.recipientAccount);
      if (account) {
        const newBalanceRaw = (BigInt(account.balanceRaw) + BigInt(block.amountRaw)).toString();
        const updated = await this.accountStore.update(account.id, {
          balanceRaw: newBalanceRaw,
        });

        await this.emitV2Event({
          id: randomUUID(),
          type: 'account.balance_updated',
          timestamp: new Date().toISOString(),
          data: { account: updated, previousBalanceRaw: account.balanceRaw },
          resourceId: updated.id,
          resourceType: 'account',
        });
      }
    }

    // Idempotency guard: if we already processed this block for invoice matching, skip.
    const existingPayment = await this.paymentStore.getByBlockHash(block.blockHash);
    if (existingPayment !== undefined) {
      return;
    }

    // Find open invoices for the recipient account, sorted oldest-first (FIFO).
    const openInvoices = await this.invoiceStore.getByRecipientAccount(
      block.recipientAccount,
      'open',
    );

    if (openInvoices.length === 0) return;

    // Sort by createdAt ascending — oldest first.
    openInvoices.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const invoice = openInvoices[0]!;

    // Create the payment record.
    const payment = await this.paymentStore.create({
      id: randomUUID(),
      invoiceId: invoice.id,
      status: 'confirmed',
      currency: 'XNO',
      amountRaw: block.amountRaw,
      recipientAccount: block.recipientAccount,
      senderAccount: block.senderAccount,
      sendBlockHash: block.blockHash,
      confirmedAt: block.confirmedAt,
    });

    // Update confirmed amount on the invoice.
    const newConfirmedRaw = (
      BigInt(invoice.confirmedAmountRaw) + BigInt(block.amountRaw)
    ).toString();

    const updatedInvoice = await this.invoiceStore.update(invoice.id, {
      confirmedAmountRaw: newConfirmedRaw,
    });

    // Emit payment.confirmed
    await this.emitEvent({
      id: randomUUID(),
      type: 'payment.confirmed',
      createdAt: new Date().toISOString(),
      data: { payment, invoice: updatedInvoice },
    });

    // Check if invoice is now fully paid.
    const isComplete =
      invoice.completionPolicy?.type === 'exact'
        ? BigInt(newConfirmedRaw) === BigInt(invoice.expectedAmountRaw)
        : BigInt(newConfirmedRaw) >= BigInt(invoice.expectedAmountRaw);
    if (isComplete) {
      const completedInvoice = await this.invoiceStore.update(invoice.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });

      await this.emitEvent({
        id: randomUUID(),
        type: 'invoice.completed',
        createdAt: new Date().toISOString(),
        data: { invoice: completedInvoice },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  private async runExpiryCheck(): Promise<void> {
    const now = new Date().toISOString();
    const openInvoices = await this.invoiceStore.list({ status: 'open' });

    for (const invoice of openInvoices) {
      if (invoice.expiresAt !== undefined && invoice.expiresAt <= now) {
        const updated = await this.invoiceStore.update(invoice.id, {
          status: 'expired',
          expiredAt: new Date().toISOString(),
        });

        await this.emitEvent({
          id: randomUUID(),
          type: 'invoice.expired',
          createdAt: new Date().toISOString(),
          data: { invoice: updated },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  private async emitEvent(event: LegacyRaiFlowEvent): Promise<void> {
    await this.eventStore.append(event);

    // Notify local listeners (fire-and-forget).
    const targets = [
      ...(this.listeners.get(event.type) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    for (const fn of targets) {
      try {
        void Promise.resolve(fn(event)).catch(() => {});
      } catch {
        // Swallow sync throws from listener
      }
    }

    const endpoints = await this.webhookEndpointStore.getByEventType(event.type);
    await this.webhookDelivery.deliver(event, endpoints);
  }

  private async emitV2Event(event: RaiFlowEvent): Promise<void> {
    if (this.v2EventStore) {
      await this.v2EventStore.append(event);
    }

    // Notify local listeners (fire-and-forget).
    const targets = [
      ...(this.listeners.get(event.type as RaiFlowEventType) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    for (const fn of targets) {
      try {
        void Promise.resolve(fn(event as unknown as LegacyRaiFlowEvent)).catch(() => {});
      } catch {
        // Swallow sync throws from listener
      }
    }

    const endpoints = await this.webhookEndpointStore.getByEventType(event.type);
    await this.webhookDelivery.deliver(event, endpoints);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async getNextManagedDerivationIndex(): Promise<number> {
    if (!this.accountStore) return 0;
    const managed = await this.accountStore.list({ type: 'managed' });
    const maxIndex = managed.reduce((max, acc) =>
      acc.derivationIndex !== null && acc.derivationIndex > max ? acc.derivationIndex : max,
      -1,
    );
    return maxIndex + 1;
  }
}
