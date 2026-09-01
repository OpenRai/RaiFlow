// @openrai/runtime — Runtime core

import { randomUUID } from 'node:crypto';
import type {
  InvoiceStatus,
  RaiFlowEventType,
  WatcherSink,
  ConfirmedBlock,
  CompletionPolicy,
  LegacyInvoice,
  LegacyPayment,
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
  IdempotencyReplayStore,
  Invoice,
  Payment,
  EventQueryOptions,
  PaginatedEventsResponse,
  InvoiceAccountStore,
  InvoiceAccount,
  ReceiveTaskStore,
  ReceiveTask,
  ReceiveTaskStatus,
} from '@openrai/model';
import {
  RaiFlowError,
  deriveInvoiceIndex,
  deriveManagedIndex,
  INVOICE_DERIVATION_START,
  MANAGED_DERIVATION_START,
} from '@openrai/model';
import { NanoAddress } from '@openrai/nano-core';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool, RpcPoolState } from '@openrai/rpc';
import type { RunMode } from '@openrai/config';
import {
  createSqliteInvoiceAccountStore,
  createSqliteReceiveTaskStore,
} from '@openrai/storage';
import {
  createWebhookDelivery,
  createWebhookEndpointStore,
  type WebhookDelivery,
} from '@openrai/webhook';
import {
  createInvoiceStore,
  createPaymentStore,
  createEventStore,
  createIdempotencyReplayStore,
} from './stores.js';
import { SendOrchestrator } from './send-orchestrator.js';
import { ReceiveOrchestrator } from './receive-orchestrator.js';

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
  /** Poll interval for confirmation of caller-signed blocks. Default 2000 (2s). */
  blockConfirmationIntervalMs?: number;
  /** Maximum time to wait for caller-signed block confirmation. Default 120000 (2m). */
  blockConfirmationTimeoutMs?: number;
  accountStore?: AccountStore;
  sendStore?: SendStore;
  invoiceAccountStore?: InvoiceAccountStore;
  receiveTaskStore?: ReceiveTaskStore;
  custodyEngine?: CustodyEngine;
  rpcPool?: RpcPool;
  watcher?: WatcherLike;
  mode?: RunMode;
  idempotencyStore?: IdempotencyReplayStore;
  derivationStartIndex?: {
    invoice: number;
    managed: number;
  };
}

/** States that cannot be transitioned out of. */
const TERMINAL_STATES = new Set<InvoiceStatus>(['completed', 'expired', 'canceled']);
const IDEMPOTENCY_SCOPE = {
  invoiceCreate: 'invoice.create',
  invoiceCancel: 'invoice.cancel',
  accountCreateManaged: 'account.create.managed',
  accountCreateWatched: 'account.create.watched',
  accountUpdate: 'account.update',
  accountDelete: 'account.delete',
  sendQueue: 'send.queue',
  webhookCreate: 'webhook.create',
  webhookDelete: 'webhook.delete',
  blockPublish: 'block.publish',
} as const;

function createInMemoryInvoiceAccountStore(): InvoiceAccountStore {
  void createSqliteInvoiceAccountStore;
  const byKey = new Map<string, InvoiceAccount>();
  const byIndex = new Map<number, InvoiceAccount>();

  function storeKey(accountKey: string, invoiceKey: string | null): string {
    return `${accountKey}\0${invoiceKey ?? ''}`;
  }

  return {
    async getOrCreate(accountKey, invoiceKey, derivationIndex, deriveAddress) {
      const key = storeKey(accountKey, invoiceKey);
      const existing = byKey.get(key);
      if (existing) return existing;

      const collision = byIndex.get(derivationIndex);
      if (collision && (collision.accountKey !== accountKey || collision.invoiceKey !== invoiceKey)) {
        throw new Error(
          `Derivation index collision: index ${derivationIndex} is already assigned to (${collision.accountKey}, ${collision.invoiceKey ?? 'null'})`,
        );
      }

      const created: InvoiceAccount = {
        accountKey,
        invoiceKey,
        derivationIndex,
        address: deriveAddress(derivationIndex),
        createdAt: new Date().toISOString(),
      };
      byKey.set(key, created);
      byIndex.set(derivationIndex, created);
      return created;
    },
    async get(accountKey, invoiceKey) {
      return byKey.get(storeKey(accountKey, invoiceKey));
    },
    async listByAccountKey(accountKey) {
      return [...byKey.values()].filter((account) => account.accountKey === accountKey);
    },
  };
}

function createInMemoryReceiveTaskStore(): ReceiveTaskStore {
  void createSqliteReceiveTaskStore;
  const tasks = new Map<string, ReceiveTask>();
  const byPendingHash = new Map<string, string>();

  return {
    async create(task) {
      if (byPendingHash.has(task.pendingBlockHash)) {
        throw new Error(`ReceiveTask for hash already exists: ${task.pendingBlockHash}`);
      }
      const created: ReceiveTask = {
        ...task,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      tasks.set(created.id, created);
      byPendingHash.set(created.pendingBlockHash, created.id);
      return created;
    },
    async get(id) {
      return tasks.get(id);
    },
    async getByPendingBlockHash(hash) {
      const id = byPendingHash.get(hash);
      return id ? tasks.get(id) : undefined;
    },
    async listByStatus(status: ReceiveTaskStatus) {
      return [...tasks.values()]
        .filter((task) => task.status === status)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async update(id, patch) {
      const existing = tasks.get(id);
      if (!existing) throw new Error(`ReceiveTask ${id} not found`);
      const updated = { ...existing, ...patch };
      tasks.set(id, updated);
      return updated;
    },
  };
}

function legacyToV2Invoice(invoice: LegacyInvoice, idempotencyKey?: string): Invoice {
  return {
    id: invoice.id,
    accountKey: invoice.accountKey ?? '',
    invoiceKey: invoice.invoiceKey ?? null,
    status: invoice.status,
    payAddress: invoice.recipientAccount,
    expectedAmountRaw: invoice.expectedAmountRaw,
    receivedAmountRaw: invoice.confirmedAmountRaw,
    memo: null,
    metadata: invoice.metadata
      ? Object.fromEntries(Object.entries(invoice.metadata).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
      : null,
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

function v2ToLegacyInvoice(invoice: Invoice): LegacyInvoice {
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
    metadata: invoice.metadata ? { ...invoice.metadata } : undefined,
    completionPolicy: invoice.completionPolicy,
  };
}

function legacyToV2Payment(payment: LegacyPayment): Payment {
  return {
    id: payment.id,
    invoiceId: payment.invoiceId,
    status: payment.status,
    blockHash: payment.sendBlockHash,
    senderAddress: payment.senderAccount ?? null,
    amountRaw: payment.amountRaw,
    confirmedAt: payment.confirmedAt ?? null,
    detectedAt: payment.confirmedAt,
  };
}

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
  readonly mode: RunMode;
  readonly idempotencyStore: IdempotencyReplayStore;

  private readonly v2EventStore?: EventStore;
  private readonly invoiceDerivationStartIndex: number;
  private readonly managedDerivationStartIndex: number;
  private readonly webhookDelivery: WebhookDelivery;
  private readonly expiryIntervalMs: number;
  private readonly blockConfirmationIntervalMs: number;
  private readonly blockConfirmationTimeoutMs: number;
  private expiryTimer: ReturnType<typeof setInterval> | undefined;
  private readonly blockConfirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly confirmingBlocks = new Set<string>();
  private invoiceAccountStore?: InvoiceAccountStore;
  private receiveTaskStore?: ReceiveTaskStore;
  private receiveOrchestrator?: ReceiveOrchestrator;
  private receiveWorkerInterval?: ReturnType<typeof setInterval>;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly sendOrchestrator?: SendOrchestrator;
  private readonly processingConfirmedBlocks = new Set<string>();
  private readonly processedConfirmedBlocks = new Set<string>();
  watcher?: WatcherLike;

  constructor(config: RuntimeConfig = {}) {
    this.mode = config.mode ?? 'custodial';
    this.invoiceStore = config.invoiceStore ?? createInvoiceStore();
    this.paymentStore = config.paymentStore ?? createPaymentStore();
    this.eventStore = config.eventStore ?? createEventStore();
    this.v2EventStore = config.v2EventStore;
    this.idempotencyStore = config.idempotencyStore ?? createIdempotencyReplayStore();
    this.webhookEndpointStore =
      config.webhookEndpointStore ?? createWebhookEndpointStore();
    this.webhookDelivery = config.webhookDelivery ?? createWebhookDelivery();
    this.expiryIntervalMs = config.expiryIntervalMs ?? 10_000;
    this.blockConfirmationIntervalMs = config.blockConfirmationIntervalMs ?? 2_000;
    this.blockConfirmationTimeoutMs = config.blockConfirmationTimeoutMs ?? 120_000;
    this.accountStore = config.accountStore;
    this.sendStore = config.sendStore;
    this.invoiceAccountStore = config.invoiceAccountStore ?? createInMemoryInvoiceAccountStore();
    this.receiveTaskStore = config.receiveTaskStore ?? createInMemoryReceiveTaskStore();
    this.custodyEngine = config.custodyEngine;
    this.rpcPool = config.rpcPool;
    this.watcher = config.watcher;
    this.invoiceDerivationStartIndex = config.derivationStartIndex?.invoice ?? INVOICE_DERIVATION_START;
    this.managedDerivationStartIndex = config.derivationStartIndex?.managed ?? MANAGED_DERIVATION_START;

    if (this.invoiceDerivationStartIndex === this.managedDerivationStartIndex) {
      throw new Error('Invoice and managed derivation start indices must not overlap');
    }

    if (this.sendStore && this.accountStore && this.custodyEngine && this.rpcPool) {
      this.sendOrchestrator = new SendOrchestrator(
        this.sendStore,
        this.accountStore,
        this.custodyEngine,
        this.rpcPool,
        (event) => this.emitV2Event(event),
      );
    }

    if (this.custodyEngine && this.receiveTaskStore && this.rpcPool) {
      this.receiveOrchestrator = new ReceiveOrchestrator(
        this.receiveTaskStore,
        this.custodyEngine,
        this.rpcPool,
        (event: unknown) => this.emitV2Event(event as RaiFlowEvent),
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
    if (this.receiveOrchestrator && this.receiveWorkerInterval === undefined) {
      this.receiveWorkerInterval = setInterval(() => {
        void this.receiveOrchestrator!.processNext();
      }, 500);
      if (
        typeof this.receiveWorkerInterval === 'object' &&
        this.receiveWorkerInterval !== null &&
        'unref' in this.receiveWorkerInterval
      ) {
        (this.receiveWorkerInterval as NodeJS.Timeout).unref();
      }
    }
    void this.recoverBlockConfirmations();
  }

  /** Stop the expiry scheduler, send orchestrator, and shut down webhook delivery. */
  stop(): void {
    if (this.expiryTimer !== undefined) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.sendOrchestrator?.stop();
    if (this.receiveWorkerInterval !== undefined) {
      clearInterval(this.receiveWorkerInterval);
      this.receiveWorkerInterval = undefined;
    }
    for (const timer of this.blockConfirmationTimers.values()) clearTimeout(timer);
    this.blockConfirmationTimers.clear();
    this.confirmingBlocks.clear();
    this.webhookDelivery.shutdown();
  }

  // -------------------------------------------------------------------------
  // Invoice management
  // -------------------------------------------------------------------------

  async createInvoice(
    params: {
      /** Amount in raw (string). Provide this or `expectedAmount`. */
      expectedAmountRaw?: string;
      /** Amount in XNO (human-readable). Converted to raw via `xnoToRaw`. */
      expectedAmount?: string;
      accountKey: string;
      invoiceKey?: string;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
      completionPolicy?: CompletionPolicy;
    },
    idempotencyKey?: string,
  ): Promise<Invoice> {
    if (this.mode === 'non-custodial') {
      throw RaiFlowError.badRequest(
        'Invoices are not available in non-custodial mode',
      );
    }
    if (!this.custodyEngine) {
      throw RaiFlowError.badRequest('Custody engine not configured');
    }
    if (!params.accountKey) {
      throw RaiFlowError.badRequest(
        'accountKey is required. Use a stable identifier for the payer or payment context ' +
        '(e.g. a customer ID, username, or purpose string). This ensures the derived address ' +
        'is recoverable if your database is lost.',
      );
    }

    const resolvedAmountRaw =
      params.expectedAmountRaw ??
      (params.expectedAmount !== undefined ? xnoToRaw(params.expectedAmount) : undefined);

    if (resolvedAmountRaw === undefined) {
      throw new Error('Either expectedAmountRaw or expectedAmount is required');
    }

    if (idempotencyKey) {
      const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.invoiceCreate, idempotencyKey);
      if (replay) {
        const existing = await this.invoiceStore.get(replay.resourceId);
        if (existing) return legacyToV2Invoice(existing, idempotencyKey);
      }
    }

    const invoiceKey = params.invoiceKey ?? null;
    const derivationIndex = deriveInvoiceIndex(
      params.accountKey,
      invoiceKey,
      this.invoiceDerivationStartIndex,
    );

    const invoiceAccountStore = this.invoiceAccountStore;
    if (!invoiceAccountStore) {
      throw RaiFlowError.badRequest('Invoice account store not configured');
    }

    const invoiceAccount = await invoiceAccountStore.getOrCreate(
      params.accountKey,
      invoiceKey,
      derivationIndex,
      (idx) => this.custodyEngine!.deriveInvoiceAddress({ index: idx }),
    );

    const payAddress = invoiceAccount.address;
    console.info(
      `[raiflow] invoice account resolved: ADDRESS=${payAddress} ALIAS=${params.accountKey}`,
    );

    const invoice: LegacyInvoice = {
      id: randomUUID(),
      status: 'open',
      currency: 'XNO',
      expectedAmountRaw: resolvedAmountRaw,
      confirmedAmountRaw: '0',
      recipientAccount: payAddress,
      derivationIndex,
      accountKey: params.accountKey,
      invoiceKey: invoiceKey ?? undefined,
      createdAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
      metadata: params.metadata,
      completionPolicy: params.completionPolicy ?? { type: 'at_least' },
    };

    const stored = await this.invoiceStore.create(invoice);
    if (idempotencyKey) {
      const persisted = await this.idempotencyStore.put(
        IDEMPOTENCY_SCOPE.invoiceCreate,
        idempotencyKey,
        'invoice',
        stored.id,
      );
      if (persisted.resourceId !== stored.id) {
        const existing = await this.invoiceStore.get(persisted.resourceId);
        if (existing) return legacyToV2Invoice(existing, idempotencyKey);
      }
    }

    await this.emitV2Event({
      id: randomUUID(),
      type: 'invoice.created',
      timestamp: new Date().toISOString(),
      data: { invoice: legacyToV2Invoice(stored, idempotencyKey) },
      resourceId: stored.id,
      resourceType: 'invoice',
    });

    // Invoice accounts are not managed accounts and therefore are not in the
    // account-state store. They must still be watched so confirmed incoming
    // sends reach invoice matching and the receive orchestrator.
    this.watcher?.addAccount(payAddress);
    this.receiveOrchestrator?.enqueueReceivables(payAddress, derivationIndex);

    return legacyToV2Invoice(stored, idempotencyKey);
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    const invoice = await this.invoiceStore.get(id);
    if (!invoice) return undefined;
    if (invoice.derivationIndex != null) {
      this.receiveOrchestrator?.enqueueReceivables(
        (invoice as LegacyInvoice & { payAddress?: string }).payAddress ?? invoice.recipientAccount,
        invoice.derivationIndex,
      );
    }
    return legacyToV2Invoice(invoice);
  }

  async listInvoices(filter?: { status?: InvoiceStatus }): Promise<Invoice[]> {
    const invoices = await this.invoiceStore.list(filter);
    return invoices.map((invoice) => legacyToV2Invoice(invoice));
  }

  async getInvoicesByAccountKey(accountKey: string): Promise<Invoice[]> {
    const invoices = await this.invoiceStore.list();
    return invoices
      .filter((inv) => (inv as LegacyInvoice & { accountKey?: string }).accountKey === accountKey)
      .map((inv) => legacyToV2Invoice(inv));
  }

  async getInvoiceAccountBalance(
    accountKey: string,
    invoiceKey: string | null,
  ): Promise<{ balanceRaw: string; pendingRaw: string; address: string } | undefined> {
    const account = await this.invoiceAccountStore?.get(accountKey, invoiceKey);
    if (!account) return undefined;

    this.receiveOrchestrator?.enqueueReceivables(account.address, account.derivationIndex);

    const client = this.rpcPool?.getClient();
    if (!client) {
      return {
        balanceRaw: '0',
        pendingRaw: '0',
        address: account.address,
      };
    }

    const info = await client.accountInfo(account.address).catch(() => undefined);
    const receivable = await client.accountsReceivable(account.address).catch(() => []);
    // Unopened-account RPC responses can contain placeholder entries without
    // an amount. Ignore those rather than turning a status read into a 500.
    const pendingRaw = receivable
      .filter((block) => typeof (block as { amount?: unknown })?.amount === 'string')
      .reduce((sum, block) => sum + BigInt((block as { amount: string }).amount), 0n)
      .toString();

    return {
      balanceRaw: info?.balance ?? '0',
      pendingRaw,
      address: account.address,
    };
  }

  async getInvoiceAccountAggregatedBalance(accountKey: string): Promise<{
    confirmedAmountRaw: string;
    pendingAmountRaw: string;
    invoiceCount: number;
    addresses: string[];
  }> {
    const invoices = await this.getInvoicesByAccountKey(accountKey);
    const accounts = await this.invoiceAccountStore?.listByAccountKey(accountKey) ?? [];
    let confirmed = 0n;
    let pending = 0n;
    for (const inv of invoices) {
      confirmed += BigInt(inv.receivedAmountRaw ?? '0');
      if (inv.status === 'open') {
        pending += BigInt(inv.expectedAmountRaw ?? '0');
      }
    }
    return {
      confirmedAmountRaw: confirmed.toString(),
      pendingAmountRaw: pending.toString(),
      invoiceCount: invoices.length,
      addresses: [...new Set(accounts.map((a) => a.address))],
    };
  }

  async cancelInvoice(id: string, idempotencyKey?: string): Promise<Invoice> {
    if (idempotencyKey) {
      const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.invoiceCancel, idempotencyKey);
      if (replay) {
        const existing = await this.getInvoice(replay.resourceId);
        if (existing) return existing;
      }
    }

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
    if (idempotencyKey) {
      await this.idempotencyStore.put(
        IDEMPOTENCY_SCOPE.invoiceCancel,
        idempotencyKey,
        'invoice',
        updated.id,
      );
    }

    await this.emitV2Event({
      id: randomUUID(),
      type: 'invoice.canceled',
      timestamp: new Date().toISOString(),
      data: { invoice: legacyToV2Invoice(updated) },
      resourceId: updated.id,
      resourceType: 'invoice',
    });

    return legacyToV2Invoice(updated);
  }

  // -------------------------------------------------------------------------
  // Account management
  // -------------------------------------------------------------------------

  private async persistAccount(account: Account): Promise<Account> {
    await this.accountStore!.create(account);
    this.watcher?.addAccount(account.address);
    console.info(
      `[raiflow] ${account.type} account created: ADDRESS=${account.address}`
        + (account.accountKey ? ` ALIAS=${account.accountKey}` : ''),
    );
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

  async createManagedAccount(params: {
    accountKey: string;
    label?: string;
    representative?: string;
    idempotencyKey?: string;
  }): Promise<Account> {
    if (this.mode === 'non-custodial') {
      throw RaiFlowError.badRequest(
        'Managed accounts are not available in non-custodial mode',
      );
    }
    if (!this.custodyEngine) {
      throw RaiFlowError.badRequest('Custody engine not configured');
    }
    if (!this.accountStore) {
      throw RaiFlowError.badRequest( 'Account store not configured');
    }
    if (!params.accountKey) {
      throw RaiFlowError.badRequest('accountKey is required for managed accounts');
    }

    if (params.idempotencyKey) {
      const replay = await this.idempotencyStore.get(
        IDEMPOTENCY_SCOPE.accountCreateManaged,
        params.idempotencyKey,
      );
      if (replay) {
        const existing = await this.accountStore.get(replay.resourceId);
        if (existing) return existing;
      }
    }

    const managedAccounts = await this.accountStore.list({ type: 'managed' });
    const existingByKey = managedAccounts.find((account) => account.accountKey === params.accountKey);
    if (existingByKey) return existingByKey;
    const nextIndex = deriveManagedIndex(params.accountKey);
    if (managedAccounts.some((account) => account.derivationIndex === nextIndex)) {
      throw RaiFlowError.conflict(`Managed account derivation collision at index ${nextIndex}`);
    }
    const address = this.custodyEngine.deriveManagedAccount({ index: nextIndex });

    const account: Account = {
      id: randomUUID(),
      accountKey: params.accountKey,
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

    const created = await this.persistAccount(account);
    if (params.idempotencyKey) {
      await this.idempotencyStore.put(
        IDEMPOTENCY_SCOPE.accountCreateManaged,
        params.idempotencyKey,
        'account',
        created.id,
      );
    }
    return created;
  }

  async createWatchedAccount(params: {
    address: string;
    label?: string;
    idempotencyKey: string;
  }): Promise<Account> {
    if (!this.accountStore) {
      throw RaiFlowError.badRequest( 'Account store not configured');
    }

    try {
      NanoAddress.parse(params.address);
    } catch {
      throw RaiFlowError.badRequest( `Invalid Nano address: ${params.address}`);
    }

    const replay = await this.idempotencyStore.get(
      IDEMPOTENCY_SCOPE.accountCreateWatched,
      params.idempotencyKey,
    );
    if (replay) {
      const replayed = await this.accountStore.get(replay.resourceId);
      if (replayed) return replayed;
    }

    const existing = await this.accountStore.getByAddress(params.address);
    if (existing) {
      return existing;
    }

    const account: Account = {
      id: randomUUID(),
      accountKey: null,
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

    const created = await this.persistAccount(account);
    await this.idempotencyStore.put(
      IDEMPOTENCY_SCOPE.accountCreateWatched,
      params.idempotencyKey,
      'account',
      created.id,
    );
    return created;
  }

  async listAccounts(filter?: { type?: AccountType }): Promise<Account[]> {
    if (!this.accountStore) return [];
    return this.accountStore.list(filter);
  }

  async getAccount(id: string): Promise<Account | undefined> {
    if (!this.accountStore) return undefined;
    const account = await this.accountStore.get(id);
    if (!account) return undefined;

    // A watched account can be changed by a caller-signed block that bypasses
    // RaiFlow's custodial send/receive orchestrators. Reconcile on reads so an
    // application never signs its next block against a stale cached frontier.
    if (this.rpcPool) {
      try {
        const live = await this.rpcPool.getClient().accountInfo(account.address);
        if (live && (live.frontier !== account.frontier
          || live.balance !== account.balanceRaw
          || live.representative !== account.representative)) {
          return await this.accountStore.update(account.id, {
            frontier: live.frontier,
            balanceRaw: live.balance,
            representative: live.representative,
          });
        }
      } catch {
        // Preserve the cached state for transient upstream failures; the
        // watcher/reconciliation loop remains responsible for eventual repair.
      }
    }
    if (account.derivationIndex != null) {
      this.receiveOrchestrator?.enqueueReceivables(account.address, account.derivationIndex);
    }
    return account;
  }

  async updateAccount(id: string, patch: { label?: string; representative?: string }, idempotencyKey: string): Promise<Account> {
    if (!this.accountStore) {
      throw RaiFlowError.badRequest( 'Account store not configured');
    }
    const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.accountUpdate, idempotencyKey);
    if (replay) {
      if (replay.resourceId !== id) throw RaiFlowError.conflict('Idempotency key belongs to another account');
      const replayed = await this.accountStore.get(id);
      if (replayed) return replayed;
    }
    const existing = await this.accountStore.get(id);
    if (!existing) {
      throw RaiFlowError.notFound('Account', id);
    }
    const updated = await this.accountStore.update(id, patch);
    await this.idempotencyStore.put(IDEMPOTENCY_SCOPE.accountUpdate, idempotencyKey, 'account', id);
    return updated;
  }

  async deleteAccount(id: string, idempotencyKey: string): Promise<Account | undefined> {
    if (!this.accountStore) {
      throw RaiFlowError.badRequest('Account store not configured');
    }
    const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.accountDelete, idempotencyKey);
    if (replay) {
      if (replay.resourceId !== id) throw RaiFlowError.conflict('Idempotency key belongs to another account');
      return undefined;
    }
    const account = await this.accountStore.get(id);
    if (!account) throw RaiFlowError.notFound('Account', id);
    if (BigInt(account.balanceRaw) !== 0n || BigInt(account.pendingRaw) !== 0n) {
      throw RaiFlowError.conflict('Account must have zero balance and zero pending balance before removal');
    }
    if (this.sendStore) {
      const sends = await this.sendStore.listByAccount(id);
      if (sends.length > 0) {
        throw RaiFlowError.conflict('Account has send history and cannot be removed without losing audit records');
      }
    }

    const deleted = await this.accountStore.delete(id);
    if (!deleted) throw RaiFlowError.notFound('Account', id);
    this.watcher?.removeAccount(account.address);
    await this.emitV2Event({
      id: randomUUID(),
      type: 'account.removed',
      timestamp: new Date().toISOString(),
      data: { account },
      resourceId: account.id,
      resourceType: 'account',
    });
    await this.idempotencyStore.put(IDEMPOTENCY_SCOPE.accountDelete, idempotencyKey, 'account', id);
    return account;
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
    if (this.mode === 'non-custodial') {
      throw RaiFlowError.badRequest(
        'Sends are not available in non-custodial mode. Use POST /blocks to publish pre-signed blocks.',
      );
    }
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

    // Check idempotency via shared replay store
    const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.sendQueue, params.idempotencyKey);
    if (replay) {
      const existing = await this.sendStore.get(replay.resourceId);
      if (existing) return existing;
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
    await this.idempotencyStore.put(
      IDEMPOTENCY_SCOPE.sendQueue,
      params.idempotencyKey,
      'send',
      send.id,
    );

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

  async getPaymentsByInvoice(invoiceId: string): Promise<Payment[]> {
    const payments = await this.paymentStore.listByInvoice(invoiceId);
    return payments.map((payment) => legacyToV2Payment(payment));
  }

  async getEventsByInvoice(invoiceId: string, options?: { after?: string }) {
    if (this.v2EventStore) {
      return this.v2EventStore.list({
        resourceType: 'invoice',
        resourceId: invoiceId,
        after: options?.after,
        limit: 1000,
      });
    }
    return this.eventStore.listByInvoice(invoiceId, options);
  }

  async listEvents(options?: EventQueryOptions): Promise<PaginatedEventsResponse> {
    if (!this.v2EventStore) {
      return { data: [], nextCursor: null };
    }
    const limit = options?.limit ?? 100;
    const rows = await this.v2EventStore.list({
      ...options,
      limit: Math.max(1, Math.min(limit, 500)) + 1,
    });
    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, limit) : rows;
    const lastSequence = data[data.length - 1]?.sequence;
    const nextCursor = hasNext && lastSequence !== undefined ? String(lastSequence) : null;
    return { data, nextCursor };
  }

  async createWebhookEndpoint(
    input: Parameters<WebhookEndpointStore['create']>[0],
    idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.webhookCreate, idempotencyKey);
      if (replay) {
        const existing = await this.webhookEndpointStore.get(replay.resourceId);
        if (existing) return existing;
      }
    }

    const endpoint = await this.webhookEndpointStore.create(input);
    if (idempotencyKey) {
      await this.idempotencyStore.put(
        IDEMPOTENCY_SCOPE.webhookCreate,
        idempotencyKey,
        'webhook',
        endpoint.id,
      );
    }
    return endpoint;
  }

  async deleteWebhookEndpoint(id: string, idempotencyKey?: string): Promise<boolean> {
    if (idempotencyKey) {
      const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.webhookDelete, idempotencyKey);
      if (replay) {
        return replay.resourceId === id;
      }
    }

    const deleted = await this.webhookEndpointStore.delete(id);
    if (!deleted) return false;
    if (idempotencyKey) {
      await this.idempotencyStore.put(
        IDEMPOTENCY_SCOPE.webhookDelete,
        idempotencyKey,
        'webhook',
        id,
      );
    }
    return true;
  }

  async publishBlock(block: string, idempotencyKey?: string): Promise<{ hash: string }> {
    const client = this.rpcPool?.getClient();
    if (!client) throw RaiFlowError.badRequest('RPC not configured');

    if (idempotencyKey) {
      const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.blockPublish, idempotencyKey);
      if (replay) {
        this.trackBlockConfirmation(replay.resourceId);
        return { hash: replay.resourceId };
      }
    }

    const result = await client.process(block);
    if (idempotencyKey) {
      await this.idempotencyStore.put(
        IDEMPOTENCY_SCOPE.blockPublish,
        idempotencyKey,
        'block',
        result.hash,
      );
    }
    await this.emitV2Event({
      id: randomUUID(),
      type: 'block.published',
      timestamp: new Date().toISOString(),
      data: { blockHash: result.hash },
      resourceId: result.hash,
      resourceType: 'block',
    });
    this.trackBlockConfirmation(result.hash);
    return result;
  }

  /**
   * Confirm a caller-signed block without requiring the caller to expose keys
   * or maintain a public Nano RPC connection. The RPC pool owns endpoint
   * selection and retries; RaiFlow owns the state transition and event.
   */
  private trackBlockConfirmation(blockHash: string): void {
    if (this.confirmingBlocks.has(blockHash) || !this.rpcPool) return;
    const client = this.rpcPool.getClient();
    if (typeof client.blockInfo !== 'function') return;

    this.confirmingBlocks.add(blockHash);
    const deadline = Date.now() + this.blockConfirmationTimeoutMs;
    const poll = async (): Promise<void> => {
      if (!this.confirmingBlocks.has(blockHash)) return;
      try {
        const info = await client.blockInfo(blockHash);
        if (info?.confirmed) {
          this.confirmingBlocks.delete(blockHash);
          this.blockConfirmationTimers.delete(blockHash);
          await this.emitV2Event({
            id: randomUUID(),
            type: 'block.confirmed',
            timestamp: new Date().toISOString(),
            data: { blockHash },
            resourceId: blockHash,
            resourceType: 'block',
          });
          return;
        }
      } catch {
        // A provider may briefly reject block_info while propagating a block.
        // Keep polling until the bounded confirmation deadline.
      }

      if (Date.now() >= deadline) {
        this.confirmingBlocks.delete(blockHash);
        this.blockConfirmationTimers.delete(blockHash);
        await this.emitV2Event({
          id: randomUUID(),
          type: 'block.failed',
          timestamp: new Date().toISOString(),
          data: { blockHash, reason: 'confirmation timeout' },
          resourceId: blockHash,
          resourceType: 'block',
        });
        return;
      }

      const timer = setTimeout(() => void poll(), this.blockConfirmationIntervalMs);
      this.blockConfirmationTimers.set(blockHash, timer);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    };

    void poll();
  }

  /** Re-arm confirmation polling for accepted blocks after a process restart. */
  private async recoverBlockConfirmations(): Promise<void> {
    const store = this.v2EventStore;
    if (!store || !this.rpcPool) return;

    try {
      const [published, confirmed, failed] = await Promise.all([
        store.list({ type: 'block.published', limit: 10_000 }),
        store.list({ type: 'block.confirmed', limit: 10_000 }),
        store.list({ type: 'block.failed', limit: 10_000 }),
      ]);
      const terminal = new Set(
        [...confirmed, ...failed]
          .map((event) => event.resourceId)
          .filter((resourceId): resourceId is string => typeof resourceId === 'string'),
      );
      for (const event of published) {
        if (event.resourceId && !terminal.has(event.resourceId)) {
          this.trackBlockConfirmation(event.resourceId);
        }
      }
    } catch {
      // Startup recovery is best effort; a later publish or an operator
      // restart can retry it without changing the publication contract.
    }
  }

  async recordRpcState(state: RpcPoolState): Promise<void> {
    const activeUrl = state.activeNode?.rpc[0];
    const previousUrl = state.previousNode?.rpc[0];
    const type = `rpc.${state.status}` as RaiFlowEventType;
    const data = state.status === 'failover'
      ? { fromUrl: previousUrl ?? '', toUrl: activeUrl ?? '' }
      : { nodeUrl: activeUrl ?? previousUrl ?? '' };
    await this.emitV2Event({
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      data,
      resourceId: activeUrl ?? previousUrl ?? 'rpc',
      resourceType: 'rpc',
    });
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
    if (this.processedConfirmedBlocks.has(block.blockHash) || this.processingConfirmedBlocks.has(block.blockHash)) {
      return;
    }
    this.processingConfirmedBlocks.add(block.blockHash);
    try {
      await this.ingestConfirmedBlock(block);
      this.processedConfirmedBlocks.add(block.blockHash);
    } finally {
      this.processingConfirmedBlocks.delete(block.blockHash);
    }
  }

  private async ingestConfirmedBlock(block: ConfirmedBlock): Promise<void> {
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
          frontier: block.blockHash,
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
    if (existingPayment === undefined) {
      // Find open invoices for the recipient account, sorted oldest-first (FIFO).
      const openInvoices = await this.invoiceStore.getByRecipientAccount(
        block.recipientAccount,
        'open',
      );

      if (openInvoices.length > 0) {
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
        const v2Invoice = legacyToV2Invoice(updatedInvoice);
        const v2Payment = legacyToV2Payment(payment);

        await this.emitV2Event({
          id: randomUUID(),
          type: 'invoice.payment_received',
          timestamp: new Date().toISOString(),
          data: { payment: v2Payment, invoice: v2Invoice },
          resourceId: invoice.id,
          resourceType: 'invoice',
        });

        await this.emitV2Event({
          id: randomUUID(),
          type: 'invoice.payment_confirmed',
          timestamp: new Date().toISOString(),
          data: { payment: v2Payment, invoice: v2Invoice },
          resourceId: invoice.id,
          resourceType: 'invoice',
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

          await this.emitV2Event({
            id: randomUUID(),
            type: 'invoice.completed',
            timestamp: new Date().toISOString(),
            data: { invoice: legacyToV2Invoice(completedInvoice) },
            resourceId: completedInvoice.id,
            resourceType: 'invoice',
          });
        }
      }
    }

    await this.receiveOrchestrator?.handleConfirmedReceive(block.blockHash);

    const confirmedAccount = await this.accountStore?.getByAddress(block.recipientAccount);
    const confirmedDerivationIndex = confirmedAccount?.derivationIndex
      ?? (await this.invoiceStore.getByRecipientAccount(block.recipientAccount, 'open'))[0]?.derivationIndex
      ?? null;
    if (confirmedDerivationIndex != null) {
      this.receiveOrchestrator?.enqueueReceivables(block.recipientAccount, confirmedDerivationIndex);
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

        await this.emitV2Event({
          id: randomUUID(),
          type: 'invoice.expired',
          timestamp: new Date().toISOString(),
          data: { invoice: legacyToV2Invoice(updated) },
          resourceId: updated.id,
          resourceType: 'invoice',
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
    if (!this.accountStore) return this.managedDerivationStartIndex;
    const managed = await this.accountStore.list({ type: 'managed' });
    const maxIndex = managed.reduce((max, acc) =>
      acc.derivationIndex !== null && acc.derivationIndex > max ? acc.derivationIndex : max,
      this.managedDerivationStartIndex - 1,
    );
    return maxIndex + 1;
  }
}
