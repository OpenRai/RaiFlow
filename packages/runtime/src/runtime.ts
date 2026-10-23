// @openrai/runtime — Runtime core

import { randomUUID } from 'node:crypto';
import type {
  InvoiceStatus,
  RaiFlowEventType,
  WatcherSink,
  ConfirmedBlock,
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
  InvoiceStore,
  PaymentStore,
  CreateInvoiceRequest,
  Payment,
  Deposit,
  DepositStore,
  Refund,
  RefundStore,
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
  deriveManagedIndex,
  INVOICE_DERIVATION_START,
  MANAGED_DERIVATION_START,
} from '@openrai/model';
import { NanoAddress, NanoAmount } from '@openrai/nano-core';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool, RpcPoolState } from '@openrai/rpc';
import { DEFAULT_MINIMUM_RECEIVE_AMOUNT_XNO, minimumReceiveAmountRaw, type RunMode } from '@openrai/config';
import {
  createSqliteInvoiceAccountStore,
  createSqliteReceiveTaskStore,
  type AccountOperationLeaseStore,
  type SendBlockIntentStore,
  type ReceiveBlockIntentStore,
  type ConfirmedDepositIngestStore,
  type WebhookOutboxStore,
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
import { AccountOperationExecutor, createInMemoryAccountOperationLeaseStore } from './account-operation-executor.js';
import { createInMemorySendBlockIntentStore } from './send-block-intents.js';
import { createInMemoryReceiveBlockIntentStore } from './receive-block-intents.js';
import { parseCreateInvoiceRequest } from './invoice-request.js';
import { WebhookOutboxWorker } from './webhook-outbox-worker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventListener = (event: RaiFlowEvent) => void | Promise<void>;

export interface WatcherLike {
  addAccount(account: string): void;
  removeAccount(account: string): void;
}

// ---------------------------------------------------------------------------
// XNO → raw conversion
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable XNO amount string to raw (the smallest Nano unit).
 * Uses string manipulation + BigInt to avoid floating-point precision loss.
 *
 * @example xnoToRaw("1")      // "1000000000000000000000000000000"
 * @example xnoToRaw("0.001")  // "1000000000000000000000000000"
 */
export function xnoToRaw(xno: string): string {
  let amount: NanoAmount;
  try {
    amount = NanoAmount.fromNano(xno);
  } catch (error) {
    throw new Error(`Invalid XNO amount: ${xno}`, { cause: error });
  }
  if (amount.raw === '0') throw new Error(`XNO amount must be greater than zero: ${xno}`);
  return amount.raw;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  /** Inclusive per-transfer minimum in XNO. Defaults to 0.000001 XNO. */
  minimumReceiveAmountXno?: string;
  autoSweepInvoices?: boolean;
  invoiceSweepDestination?: string;
  invoiceStore?: InvoiceStore;
  paymentStore?: PaymentStore;
  eventStore?: EventStore;
  webhookEndpointStore?: WebhookEndpointStore;
  webhookDelivery?: WebhookDelivery;
  webhookOutboxStore?: WebhookOutboxStore;
  /** Interval in ms for the expiry checker. Default 10000 (10s). */
  expiryIntervalMs?: number;
  /** Default invoice lifetime in seconds. Omit to disable automatic expiry. */
  defaultExpirySeconds?: number;
  /** Poll interval for confirmation of caller-signed blocks. Default 2000 (2s). */
  blockConfirmationIntervalMs?: number;
  /** Maximum time to wait for caller-signed block confirmation. Default 120000 (2m). */
  blockConfirmationTimeoutMs?: number;
  accountStore?: AccountStore;
  sendStore?: SendStore;
  invoiceAccountStore?: InvoiceAccountStore;
  receiveTaskStore?: ReceiveTaskStore;
  accountOperationLeaseStore?: AccountOperationLeaseStore;
  sendBlockIntentStore?: SendBlockIntentStore;
  receiveBlockIntentStore?: ReceiveBlockIntentStore;
  depositStore?: DepositStore;
  confirmedDepositIngestStore?: ConfirmedDepositIngestStore;
  refundStore?: RefundStore;
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
  refundCreate: 'refund.create',
  webhookCreate: 'webhook.create',
  webhookDelete: 'webhook.delete',
  blockPublish: 'block.publish',
} as const;

function createInMemoryInvoiceAccountStore(): InvoiceAccountStore {
  void createSqliteInvoiceAccountStore;
  const byKey = new Map<string, InvoiceAccount>();
  const byIndex = new Map<number, InvoiceAccount>();
  const byAccount = new Map<string, InvoiceAccount[]>();

  function storeKey(accountKey: string, invoiceKey: string | null): string {
    return `${accountKey}\0${invoiceKey ?? ''}`;
  }

  return {
    async getOrCreate(accountKey, invoiceKey, derivationStartIndex, derivationEndIndex, deriveAddress) {
      const key = storeKey(accountKey, invoiceKey);
      if (invoiceKey !== null) {
        const existing = byKey.get(key);
        if (existing) return existing;
      }
      const allocated = [...byIndex.keys()].filter((index) => index >= derivationStartIndex && index < derivationEndIndex);
      const derivationIndex = Math.max(derivationStartIndex, (allocated.length ? Math.max(...allocated) : derivationStartIndex - 1) + 1);
      if (derivationIndex >= derivationEndIndex) throw new Error(`Invoice derivation range exhausted at index ${derivationEndIndex}`);

      const created: InvoiceAccount = {
        accountKey,
        invoiceKey,
        derivationIndex,
        address: deriveAddress(derivationIndex),
        createdAt: new Date().toISOString(),
      };
      if (invoiceKey !== null) byKey.set(key, created);
      byIndex.set(derivationIndex, created);
      byAccount.set(accountKey, [...(byAccount.get(accountKey) ?? []), created]);
      return created;
    },
    async get(accountKey, invoiceKey) {
      return invoiceKey === null
        ? [...(byAccount.get(accountKey) ?? [])].reverse().find((account) => account.invoiceKey === null)
        : byKey.get(storeKey(accountKey, invoiceKey));
    },
    async listByAccountKey(accountKey) {
      return [...(byAccount.get(accountKey) ?? [])];
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

function createInMemoryDepositStore(): DepositStore {
  const deposits = new Map<string, Deposit>();
  return {
    async createIfAbsent(deposit) {
      const existing = deposits.get(deposit.blockHash);
      if (existing) {
        if (existing.invoiceId === null && deposit.invoiceId !== null) {
          const linked = { ...existing, invoiceId: deposit.invoiceId };
          deposits.set(deposit.blockHash, linked);
          return linked;
        }
        return existing;
      }
      deposits.set(deposit.blockHash, deposit);
      return deposit;
    },
    async getByBlockHash(hash) {
      return deposits.get(hash);
    },
    async get(id) {
      return [...deposits.values()].find((deposit) => deposit.id === id);
    },
    async listByRecipientAccounts(addresses) {
      const addressSet = new Set(addresses);
      return [...deposits.values()]
        .filter((deposit) => addressSet.has(deposit.recipientAccount))
        .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt) || b.blockHash.localeCompare(a.blockHash));
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class Runtime implements WatcherSink {
  readonly invoiceStore: InvoiceStore;
  readonly paymentStore: PaymentStore;
  readonly eventStore: EventStore;
  readonly webhookEndpointStore: WebhookEndpointStore;
  readonly accountStore?: AccountStore;
  readonly sendStore?: SendStore;
  readonly depositStore: DepositStore;
  readonly refundStore?: RefundStore;
  readonly custodyEngine?: CustodyEngine;
  readonly rpcPool?: RpcPool;
  readonly mode: RunMode;
  readonly idempotencyStore: IdempotencyReplayStore;

  private readonly invoiceDerivationStartIndex: number;
  private readonly managedDerivationStartIndex: number;
  private readonly webhookDelivery: WebhookDelivery;
  private readonly webhookOutboxWorker?: WebhookOutboxWorker;
  private readonly expiryIntervalMs: number;
  private readonly defaultExpirySeconds?: number;
  private readonly minimumReceiveAmount: bigint;
  private readonly autoSweepInvoices: boolean;
  private readonly invoiceSweepDestination?: string;
  private readonly blockConfirmationIntervalMs: number;
  private readonly blockConfirmationTimeoutMs: number;
  private expiryTimer: ReturnType<typeof setInterval> | undefined;
  private readonly blockConfirmationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly confirmingBlocks = new Set<string>();
  private readonly emittedInvoiceSweeps = new Set<string>();
  private readonly emittingInvoiceSweeps = new Set<string>();
  private invoiceAccountStore?: InvoiceAccountStore;
  private receiveTaskStore?: ReceiveTaskStore;
  private readonly accountOperations: AccountOperationExecutor;
  private receiveOrchestrator?: ReceiveOrchestrator;
  private receiveWorkerInterval?: ReturnType<typeof setInterval>;
  private receiveRecoveryInterval?: ReturnType<typeof setInterval>;
  private invoiceSweepInterval?: ReturnType<typeof setInterval>;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly sendOrchestrator?: SendOrchestrator;
  private readonly confirmedDepositIngestStore?: ConfirmedDepositIngestStore;
  private readonly processingConfirmedBlocks = new Set<string>();
  private readonly processedConfirmedBlocks = new Set<string>();
  watcher?: WatcherLike;

  constructor(config: RuntimeConfig = {}) {
    this.minimumReceiveAmount = BigInt(minimumReceiveAmountRaw(
      config.minimumReceiveAmountXno ?? DEFAULT_MINIMUM_RECEIVE_AMOUNT_XNO,
    ));
    this.autoSweepInvoices = config.autoSweepInvoices ?? false;
    this.invoiceSweepDestination = config.invoiceSweepDestination;
    if (this.autoSweepInvoices && !this.invoiceSweepDestination) {
      throw new Error('invoiceSweepDestination is required when autoSweepInvoices is enabled');
    }
    if (this.autoSweepInvoices) {
      try {
        NanoAddress.parse(this.invoiceSweepDestination!);
      } catch (cause) {
        throw new Error('invoiceSweepDestination must be a valid Nano address', { cause });
      }
    }
    this.mode = config.mode ?? 'custodial';
    this.invoiceStore = config.invoiceStore ?? createInvoiceStore();
    this.paymentStore = config.paymentStore ?? createPaymentStore();
    this.eventStore = config.eventStore ?? createEventStore();
    this.idempotencyStore = config.idempotencyStore ?? createIdempotencyReplayStore();
    this.webhookEndpointStore =
      config.webhookEndpointStore ?? createWebhookEndpointStore();
    this.webhookDelivery = config.webhookDelivery ?? createWebhookDelivery();
    this.webhookOutboxWorker = config.webhookOutboxStore
      ? new WebhookOutboxWorker(config.webhookOutboxStore)
      : undefined;
    this.expiryIntervalMs = config.expiryIntervalMs ?? 10_000;
    this.defaultExpirySeconds = config.defaultExpirySeconds;
    this.blockConfirmationIntervalMs = config.blockConfirmationIntervalMs ?? 2_000;
    this.blockConfirmationTimeoutMs = config.blockConfirmationTimeoutMs ?? 120_000;
    this.accountStore = config.accountStore;
    this.sendStore = config.sendStore;
    this.depositStore = config.depositStore ?? createInMemoryDepositStore();
    this.refundStore = config.refundStore;
    this.confirmedDepositIngestStore = config.confirmedDepositIngestStore;
    if (Boolean(config.depositStore) !== Boolean(config.confirmedDepositIngestStore)) {
      throw new Error('Persistent deposit storage requires the atomic confirmed-deposit ingest store');
    }
    this.invoiceAccountStore = config.invoiceAccountStore ?? createInMemoryInvoiceAccountStore();
    this.receiveTaskStore = config.receiveTaskStore ?? createInMemoryReceiveTaskStore();
    this.accountOperations = new AccountOperationExecutor(
      config.accountOperationLeaseStore ?? createInMemoryAccountOperationLeaseStore(),
    );
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
        this.accountOperations,
        config.sendBlockIntentStore ?? createInMemorySendBlockIntentStore(),
        async (send) => this.emitInvoiceSweptIfMissing(send),
      );
    }

    if (this.custodyEngine && this.receiveTaskStore && this.rpcPool) {
      this.receiveOrchestrator = new ReceiveOrchestrator(
        this.receiveTaskStore,
        this.custodyEngine,
        this.rpcPool,
        (event: unknown) => this.emitV2Event(event as RaiFlowEvent),
        this.accountOperations,
        config.receiveBlockIntentStore ?? createInMemoryReceiveBlockIntentStore(),
        this.minimumReceiveAmount,
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
    this.webhookOutboxWorker?.start();
    if (this.autoSweepInvoices && this.invoiceSweepInterval === undefined) {
      void this.runInvoiceSweepCheck();
      this.invoiceSweepInterval = setInterval(() => void this.runInvoiceSweepCheck(), 2_000);
      if (typeof this.invoiceSweepInterval === 'object' && this.invoiceSweepInterval !== null && 'unref' in this.invoiceSweepInterval) {
        (this.invoiceSweepInterval as NodeJS.Timeout).unref();
      }
    }
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
    void this.recoverReceiveConfirmations();
    if (this.receiveRecoveryInterval === undefined) {
      this.receiveRecoveryInterval = setInterval(() => {
        void this.recoverReceiveConfirmations();
      }, 30_000);
      if (typeof this.receiveRecoveryInterval === 'object' && this.receiveRecoveryInterval !== null && 'unref' in this.receiveRecoveryInterval) {
        (this.receiveRecoveryInterval as NodeJS.Timeout).unref();
      }
    }
  }

  /** Stop the expiry scheduler, send orchestrator, and shut down webhook delivery. */
  stop(): void {
    if (this.expiryTimer !== undefined) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.sendOrchestrator?.stop();
    this.webhookOutboxWorker?.stop();
    if (this.invoiceSweepInterval !== undefined) {
      clearInterval(this.invoiceSweepInterval);
      this.invoiceSweepInterval = undefined;
    }
    if (this.receiveWorkerInterval !== undefined) {
      clearInterval(this.receiveWorkerInterval);
      this.receiveWorkerInterval = undefined;
    }
    if (this.receiveRecoveryInterval !== undefined) {
      clearInterval(this.receiveRecoveryInterval);
      this.receiveRecoveryInterval = undefined;
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
    params: CreateInvoiceRequest,
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
    const request = parseCreateInvoiceRequest(params);
    const resolvedAmountRaw = request.expectedAmountRaw;
    const requestedExpiry = request.expiresAt ? Date.parse(request.expiresAt) : undefined;
    if (requestedExpiry !== undefined && requestedExpiry <= Date.now()) {
      throw RaiFlowError.badRequest('expiresAt must be in the future');
    }
    const expiresAt = request.expiresAt
      ?? (this.defaultExpirySeconds === undefined
        ? undefined
        : new Date(Date.now() + this.defaultExpirySeconds * 1000).toISOString());

    if (idempotencyKey) {
      const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.invoiceCreate, idempotencyKey);
      if (replay) {
        const existing = await this.invoiceStore.get(replay.resourceId);
        if (existing) return existing;
      }
    }

    const invoiceKey = request.invoiceKey ?? null;
    if (invoiceKey !== null) {
      const existing = await this.invoiceStore.getByAccountKeyAndInvoiceKey(request.accountKey, invoiceKey);
      if (existing) {
        if (existing.expectedAmountRaw !== resolvedAmountRaw) {
          throw RaiFlowError.conflict('invoiceKey already identifies an invoice with a different expected amount');
        }
        if (idempotencyKey) {
          await this.idempotencyStore.put(
            IDEMPOTENCY_SCOPE.invoiceCreate,
            idempotencyKey,
            'invoice',
            existing.id,
          );
        }
        return existing;
      }
    }

    if (BigInt(resolvedAmountRaw) < this.minimumReceiveAmount) {
      throw RaiFlowError.badRequest(`Invoice amount must be at least the configured receiving minimum (${this.minimumReceiveAmount} raw)`);
    }

    const invoiceAccountStore = this.invoiceAccountStore;
    if (!invoiceAccountStore) {
      throw RaiFlowError.badRequest('Invoice account store not configured');
    }

    const invoiceAccount = await invoiceAccountStore.getOrCreate(
      request.accountKey,
      invoiceKey,
      this.invoiceDerivationStartIndex,
      this.managedDerivationStartIndex,
      (idx) => this.custodyEngine!.deriveInvoiceAddress({ index: idx }),
    );
    const derivationIndex = invoiceAccount.derivationIndex;

    const payAddress = invoiceAccount.address;
    console.info(
      `[raiflow] invoice account resolved: ADDRESS=${payAddress} ALIAS=${request.accountKey}`,
    );

    const now = new Date().toISOString();
    const invoice: Invoice = {
      id: randomUUID(),
      status: 'open',
      accountKey: request.accountKey,
      invoiceKey,
      payAddress,
      expectedAmountRaw: resolvedAmountRaw,
      receivedAmountRaw: '0',
      memo: null,
      metadata: request.metadata ?? null,
      idempotencyKey: idempotencyKey ?? null,
      expiresAt: expiresAt ?? null,
      completedAt: null,
      canceledAt: null,
      createdAt: now,
      updatedAt: now,
      completionPolicy: request.completionPolicy ?? { type: 'at_least' },
      derivationIndex,
    };

    const stored = await this.invoiceStore.create(invoice, idempotencyKey);
    if (idempotencyKey) {
      const persisted = await this.idempotencyStore.put(
        IDEMPOTENCY_SCOPE.invoiceCreate,
        idempotencyKey,
        'invoice',
        stored.id,
      );
      if (persisted.resourceId !== stored.id) {
        const existing = await this.invoiceStore.get(persisted.resourceId);
        if (existing) return existing;
      }
    }

    await this.emitV2Event({
      id: randomUUID(),
      type: 'invoice.created',
      timestamp: new Date().toISOString(),
      data: { invoice: stored },
      resourceId: stored.id,
      resourceType: 'invoice',
    });

    // Invoice accounts are not managed accounts and therefore are not in the
    // account-state store. They must still be watched so confirmed incoming
    // sends reach invoice matching and the receive orchestrator.
    this.watcher?.addAccount(payAddress);
    this.receiveOrchestrator?.enqueueReceivables(payAddress, derivationIndex);

    return stored;
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    const invoice = await this.invoiceStore.get(id);
    if (!invoice) return undefined;
    if (invoice.derivationIndex != null) {
      this.receiveOrchestrator?.enqueueReceivables(
        invoice.payAddress,
        invoice.derivationIndex,
      );
    }
    return invoice;
  }

  /** Resolve one invoice without scanning the account's invoice list. */
  async getInvoiceByAccountKeyAndInvoiceKey(
    accountKey: string,
    invoiceKey: string | null,
  ): Promise<Invoice | undefined> {
    const invoice = await this.invoiceStore.getByAccountKeyAndInvoiceKey(accountKey, invoiceKey);
    if (!invoice) return undefined;
    if (invoice.derivationIndex != null) {
      this.receiveOrchestrator?.enqueueReceivables(
        invoice.payAddress,
        invoice.derivationIndex,
      );
    }
    return invoice;
  }

  async listInvoices(filter?: { status?: InvoiceStatus }): Promise<Invoice[]> {
    const invoices = await this.invoiceStore.list(filter);
    return invoices;
  }

  async getInvoicesByAccountKey(accountKey: string): Promise<Invoice[]> {
    return this.invoiceStore.listByAccountKey(accountKey);
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
      .map((block) => (block as { amount?: unknown })?.amount)
      .filter((amount): amount is string => typeof amount === 'string' && /^\d+$/.test(amount))
      .reduce((sum, amount) => sum + BigInt(amount), 0n)
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

    const updated = await this.invoiceStore.transition(id, 'open', {
      status: 'canceled',
      canceledAt: new Date().toISOString(),
    });
    if (!updated) {
      const current = await this.invoiceStore.get(id);
      if (!current) throw RaiFlowError.notFound('Invoice', id);
      throw RaiFlowError.conflict(`Invoice ${id} is already in terminal state: ${current.status}`);
    }
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
      data: { invoice: updated },
      resourceId: updated.id,
      resourceType: 'invoice',
    });

    return updated;
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
        if (existing) {
          this.watcher?.addAccount(existing.address);
          return existing;
        }
      }
    }

    const managedAccounts = await this.accountStore.list({ type: 'managed' });
    const existingByKey = managedAccounts.find((account) => account.accountKey === params.accountKey);
    if (existingByKey) {
      this.watcher?.addAccount(existingByKey.address);
      return existingByKey;
    }
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
    let current = account;

    // Return a fresh view for caller-signed flows without persisting chain
    // projections here. AccountStateSync is the sole owner of those writes.
    if (this.rpcPool) {
      try {
        const live = await this.rpcPool.getClient().accountInfo(account.address);
        if (live && (live.frontier !== account.frontier
          || live.balance !== account.balanceRaw
          || live.representative !== account.representative)) {
          current = {
            ...account,
            frontier: live.frontier,
            balanceRaw: live.balance,
            representative: live.representative,
          };
        }
      } catch {
        // Preserve the cached state for transient upstream failures; the
        // watcher/reconciliation loop remains responsible for eventual repair.
      }
    }
    if (account.derivationIndex != null) {
      this.receiveOrchestrator?.enqueueReceivables(account.address, account.derivationIndex);
    }
    return current;
  }

  async getDepositsByAccount(accountId: string): Promise<Deposit[]> {
    const account = await this.accountStore?.get(accountId);
    if (!account) return [];
    return this.depositStore.listByRecipientAccounts([account.address]);
  }

  async getDepositsByAccountKey(accountKey: string): Promise<Deposit[]> {
    const [invoiceAccounts, managedAccounts] = await Promise.all([
      this.invoiceAccountStore?.listByAccountKey(accountKey) ?? Promise.resolve([]),
      this.accountStore?.list() ?? Promise.resolve([]),
    ]);
    const addresses = new Set(invoiceAccounts.map((account) => account.address));
    for (const account of managedAccounts) {
      if (account.accountKey === accountKey) addresses.add(account.address);
    }
    return this.depositStore.listByRecipientAccounts([...addresses]);
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
    let updated: Account | undefined;
    if (patch.representative !== undefined && patch.representative !== existing.representative) {
      updated = await this.accountOperations.run(existing.address, async ({ assertCurrent }) => {
        await assertCurrent();
        return this.accountStore!.update(id, patch);
      });
      if (!updated) throw RaiFlowError.conflict('Account chain is busy with another operation');
    } else {
      updated = await this.accountStore.update(id, patch);
    }
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

    const existingByKey = await this.sendStore.getByIdempotencyKey(params.idempotencyKey);
    if (existingByKey) {
      this.assertSendReplayPayload(existingByKey, params);
      return existingByKey;
    }

    // Check idempotency via shared replay store
    const replay = await this.idempotencyStore.get(IDEMPOTENCY_SCOPE.sendQueue, params.idempotencyKey);
    if (replay) {
      const existing = await this.sendStore.get(replay.resourceId);
      if (existing) {
        this.assertSendReplayPayload(existing, params);
        return existing;
      }
    }

    const send: Send = {
      id: randomUUID(),
      source: { type: 'account', accountId: account.id, address: account.address, derivationIndex: account.derivationIndex },
      destination: params.destination,
      amountRaw: params.amountRaw,
      status: 'queued',
      blockHash: null,
      idempotencyKey: params.idempotencyKey,
      createdAt: new Date().toISOString(),
      publishedAt: null,
      confirmedAt: null,
    };

    try {
      await this.sendStore.create(send);
    } catch (error) {
      // A concurrent request may have inserted this key after our lookup.
      const concurrent = await this.sendStore.getByIdempotencyKey(params.idempotencyKey);
      if (!concurrent) throw error;
      this.assertSendReplayPayload(concurrent, params);
      return concurrent;
    }

    await this.idempotencyStore.put(IDEMPOTENCY_SCOPE.sendQueue, params.idempotencyKey, 'send', send.id);

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

  async queueRefund(params: {
    depositId: string;
    destination: string;
    amountRaw: string;
    idempotencyKey: string;
  }): Promise<Refund> {
    if (this.mode === 'non-custodial') {
      throw RaiFlowError.badRequest('Refunds are not available in non-custodial mode.');
    }
    if (!this.accountStore || !this.sendStore || !this.refundStore) {
      throw RaiFlowError.badRequest('Refund storage is not configured');
    }
    const deposit = (await this.depositStore.get?.(params.depositId))
      ?? (await this.depositStore.getByBlockHash(params.depositId));
    if (!deposit) throw RaiFlowError.notFound('Deposit', params.depositId);
    try {
      NanoAddress.parse(params.destination);
    } catch {
      throw RaiFlowError.badRequest('destination must be a valid Nano address supplied by the application');
    }
    if (!/^\d+$/.test(params.amountRaw) || BigInt(params.amountRaw) <= 0n) {
      throw RaiFlowError.badRequest('amountRaw must be a positive numeric string');
    }
    if (!params.idempotencyKey.trim()) {
      throw RaiFlowError.badRequest('Idempotency-Key is required');
    }

    let source: Send['source'];
    if (deposit.invoiceId) {
      const invoice = await this.invoiceStore.get(deposit.invoiceId);
      if (!invoice || invoice.derivationIndex === null) {
        throw RaiFlowError.conflict('The deposit invoice has no available custodial send source');
      }
      source = {
        type: 'invoice',
        invoiceId: invoice.id,
        address: invoice.payAddress,
        derivationIndex: invoice.derivationIndex,
      };
    } else {
      const account = await this.accountStore.getByAddress(deposit.recipientAccount);
      if (!account || account.type !== 'managed' || account.derivationIndex === null) {
        throw RaiFlowError.conflict('The deposit recipient is not a custodial managed account');
      }
      source = {
        type: 'account',
        accountId: account.id,
        address: account.address,
        derivationIndex: account.derivationIndex,
      };
    }

    const createdAt = new Date().toISOString();
    const refundId = randomUUID();
    const send: Send = {
      id: randomUUID(),
      source,
      destination: params.destination,
      amountRaw: params.amountRaw,
      status: 'queued',
      blockHash: null,
      idempotencyKey: `refund:${deposit.id}:${params.idempotencyKey}`,
      createdAt,
      publishedAt: null,
      confirmedAt: null,
    };
    const refund: Refund = {
      id: refundId,
      depositId: deposit.id,
      invoiceId: deposit.invoiceId,
      sendId: send.id,
      destination: params.destination,
      amountRaw: params.amountRaw,
      status: 'queued',
      idempotencyKey: params.idempotencyKey,
      createdAt,
      publishedAt: null,
      confirmedAt: null,
    };

    try {
      const result = await this.refundStore.queue(deposit, refund, send);
      if (result.created) {
        const scopedKey = `${deposit.id}:${params.idempotencyKey}`;
        await this.idempotencyStore.put(IDEMPOTENCY_SCOPE.refundCreate, scopedKey, 'refund', result.refund.id);
        await this.emitV2Event({
          id: randomUUID(),
          type: 'send.queued',
          timestamp: createdAt,
          data: { send: result.send, refund: result.refund },
          resourceId: result.send.id,
          resourceType: 'send',
        });
      }
      return result.refund;
    } catch (error) {
      if (error instanceof Error && /exceeds the unrefunded|reused with different/i.test(error.message)) {
        throw RaiFlowError.conflict(error.message);
      }
      throw error;
    }
  }

  async getRefundsByDeposit(depositId: string): Promise<Refund[]> {
    const deposit = (await this.depositStore.get?.(depositId))
      ?? (await this.depositStore.getByBlockHash(depositId));
    if (!deposit) throw RaiFlowError.notFound('Deposit', depositId);
    return this.refundStore?.listByDepositId(deposit.id) ?? [];
  }

  private assertSendReplayPayload(
    existing: Send,
    request: { accountId: string; destination: string; amountRaw: string },
  ): void {
    if (
      existing.source.type !== 'account'
      || existing.source.accountId !== request.accountId
      || existing.destination !== request.destination
      || existing.amountRaw !== request.amountRaw
    ) {
      throw RaiFlowError.conflict('Idempotency key was already used with a different send request');
    }
  }

  async listSendsByAccount(accountId: string): Promise<Send[]> {
    if (!this.sendStore) return [];
    return this.sendStore.listByAccount(accountId);
  }

  /** Queue one recoverable sweep after every inbound transfer is spendable. */
  async runInvoiceSweepCheck(): Promise<void> {
    if (!this.autoSweepInvoices || !this.sendStore || !this.rpcPool || !this.invoiceAccountStore) return;
    const completed = await this.invoiceStore.list({ status: 'completed' });
    for (const invoice of completed) {
      const idempotencyKey = `invoice-sweep:${invoice.id}`;
      const existing = await this.sendStore.getByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.status === 'confirmed') await this.emitInvoiceSweptIfMissing(existing);
        continue;
      }
      if (!invoice.accountKey || invoice.derivationIndex === null) continue;

      const invoiceAccount = await this.invoiceAccountStore.get(invoice.accountKey, invoice.invoiceKey ?? null);
      if (!invoiceAccount || invoiceAccount.address !== invoice.payAddress) continue;

      const tasks = this.receiveTaskStore
        ? await Promise.all(['pending', 'processing', 'published'].map((status) =>
          this.receiveTaskStore!.listByStatus(status as ReceiveTaskStatus),
        ))
        : [];
      // A failed receive task is terminal locally, but the node's receivable
      // list below remains authoritative for whether funds are spendable.
      if (tasks.flat().some((task) => task.accountAddress === invoiceAccount.address)) continue;

      try {
        const client = this.rpcPool.getClient();
        const receivables = await client.accountsReceivable(invoiceAccount.address);
        if (Array.isArray(receivables) && receivables.length > 0) continue;
        if (typeof receivables === 'object' && receivables !== null) {
          const blocks = (receivables as { blocks?: unknown }).blocks;
          if (blocks && typeof blocks === 'object' && Object.keys(blocks).length > 0) continue;
        }
        const info = await client.accountInfo(invoiceAccount.address);
        const amountRaw = info?.balance ?? '0';
        if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) === 0n) continue;

        const send: Send = {
          id: randomUUID(),
          source: {
            type: 'invoice',
            invoiceId: invoice.id,
            address: invoiceAccount.address,
            derivationIndex: invoiceAccount.derivationIndex,
          },
          destination: this.invoiceSweepDestination!,
          amountRaw,
          status: 'queued',
          blockHash: null,
          idempotencyKey,
          createdAt: new Date().toISOString(),
          publishedAt: null,
          confirmedAt: null,
        };
        try {
          await this.sendStore.create(send);
        } catch {
          // A concurrent worker may have queued the invoice's unique sweep.
          if (!(await this.sendStore.getByIdempotencyKey(idempotencyKey))) throw new Error('Failed to persist invoice sweep');
          continue;
        }
        await this.emitV2Event({
          id: randomUUID(),
          type: 'send.queued',
          timestamp: new Date().toISOString(),
          data: { send },
          resourceId: send.id,
          resourceType: 'send',
        });
      } catch {
        // RPC and storage errors leave the invoice eligible for the next pass.
      }
    }
  }

  private async emitInvoiceSweptIfMissing(send: Send): Promise<void> {
    if (send.source.type !== 'invoice' || send.status !== 'confirmed') return;
    const invoiceId = send.source.invoiceId;
    if (this.emittedInvoiceSweeps.has(invoiceId) || this.emittingInvoiceSweeps.has(invoiceId)) return;
    this.emittingInvoiceSweeps.add(invoiceId);
    try {
      const eventId = `invoice.swept:${invoiceId}`;
      const prior = await this.eventStore.list({
        type: 'invoice.swept',
        resourceType: 'invoice',
        resourceId: invoiceId,
        limit: 1,
      });
      if (prior?.some((event) => event.id === eventId || event.type === 'invoice.swept')) {
        this.emittedInvoiceSweeps.add(invoiceId);
        return;
      }
      const invoice = await this.invoiceStore.get(invoiceId);
      if (!invoice) return;
      try {
        await this.emitV2Event({
          id: eventId,
          type: 'invoice.swept',
          timestamp: send.confirmedAt ?? new Date().toISOString(),
      data: { invoice, send },
          resourceId: invoiceId,
          resourceType: 'invoice',
        });
        this.emittedInvoiceSweeps.add(invoiceId);
      } catch (error) {
        // Deterministic IDs make concurrent runtime instances converge on one
        // persisted event. Treat an already persisted winner as success.
        const persisted = await this.eventStore.list({
          type: 'invoice.swept',
          resourceType: 'invoice',
          resourceId: invoiceId,
          limit: 1,
        });
        if (!persisted?.some((event) => event.id === eventId)) throw error;
        this.emittedInvoiceSweeps.add(invoiceId);
      }
    } finally {
      this.emittingInvoiceSweeps.delete(invoiceId);
    }
  }

  async getSend(id: string): Promise<Send | undefined> {
    if (!this.sendStore) return undefined;
    return this.sendStore.get(id);
  }

  // -------------------------------------------------------------------------
  // Payment / event queries
  // -------------------------------------------------------------------------

  async getPaymentsByInvoice(invoiceId: string): Promise<Payment[]> {
    return this.paymentStore.listByInvoice(invoiceId);
  }

  async getEventsByInvoice(invoiceId: string, options?: { after?: string }) {
    return this.eventStore.list({
      resourceType: 'invoice',
      resourceId: invoiceId,
      after: options?.after,
      limit: 1000,
    });
  }

  async listEvents(options?: EventQueryOptions): Promise<PaginatedEventsResponse> {
    const limit = options?.limit ?? 100;
    const rows = await this.eventStore.list({
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
          // Caller-signed publishes do not pass through the watcher. Once the
          // confirmation probe has the decoded send details, feed the same
          // idempotent ingestion path used by watched-account confirmations so
          // invoices complete immediately; the watcher remains recovery-only.
          if (info.subtype === 'send' && info.blockAccount && info.recipientAccount && info.amount) {
            await this.handleConfirmedBlock({
              blockHash,
              senderAccount: info.blockAccount,
              recipientAccount: info.recipientAccount,
              amountRaw: info.amount,
              confirmedAt: info.localTimestamp
                ? new Date(Number(info.localTimestamp) * 1000).toISOString()
                : new Date().toISOString(),
            });
          }
          await this.emitV2Event({
            id: randomUUID(),
            type: 'block.confirmed',
            timestamp: new Date().toISOString(),
            data: {
              blockHash,
              ...(info.blockAccount ? { senderAccount: info.blockAccount } : {}),
              ...(info.recipientAccount ? { recipientAccount: info.recipientAccount } : {}),
              ...(info.amount ? { amountRaw: info.amount } : {}),
            },
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
    const store = this.eventStore;
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

  /**
   * Recover invoice payments whose incoming send was received by RaiFlow but
   * whose watcher event was missed (for example during an RPC outage). The
   * receive task keeps the original pending-send hash, so a confirmed block
   * lookup is enough to replay the normal idempotent invoice transition.
   */
  private async recoverReceiveConfirmations(): Promise<void> {
    if (!this.receiveTaskStore || !this.rpcPool) return;

    try {
      const tasks = [
        ...(await this.receiveTaskStore.listByStatus('published')),
        ...(await this.receiveTaskStore.listByStatus('confirmed')),
      ];
      const client = this.rpcPool.getClient();
      for (const task of tasks) {
        try {
          // A receive task has its own state block. Confirming the original
          // pending send only proves that funds became receivable; the task is
          // complete when RaiFlow's receive/open block is confirmed.
          if (task.status === 'published' && task.receiveBlockHash) {
            const receiveInfo = await client.blockInfo(task.receiveBlockHash);
            if (receiveInfo?.confirmed) {
              await this.receiveOrchestrator?.handleConfirmedReceiveBlock(task.receiveBlockHash);
            }
          }
          const info = await client.blockInfo(task.pendingBlockHash);
          if (!info?.confirmed || (info.subtype !== undefined && info.subtype !== 'send')) continue;
          await this.handleConfirmedBlock({
            blockHash: task.pendingBlockHash,
            senderAccount: info.blockAccount ?? '',
            recipientAccount: task.accountAddress,
            amountRaw: info.amount ?? task.amountRaw,
            confirmedAt: info.localTimestamp
              ? new Date(Number(info.localTimestamp) * 1000).toISOString()
              : new Date().toISOString(),
          });
        } catch {
          // A provider may not know the block yet; the next restart or watcher
          // delivery will retry without changing the payment contract.
        }
      }
    } catch {
      // Startup recovery is best effort and must not prevent RaiFlow startup.
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
      // Ignored dust must not grow the in-memory deduplication set either.
      if (BigInt(block.amountRaw) >= this.minimumReceiveAmount) {
        this.processedConfirmedBlocks.add(block.blockHash);
      }
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

    // Confirmation recovery for operations we already started must survive a
    // raised admission minimum. Apply the minimum before any inbound writes.
    await this.receiveOrchestrator?.handleConfirmedReceiveBlock(block.blockHash);
    if (BigInt(block.amountRaw) < this.minimumReceiveAmount) return;

    if (this.confirmedDepositIngestStore) {
      const result = await this.confirmedDepositIngestStore.ingest(block);
      for (const event of result.events) await this.dispatchV2Event(event);
      return;
    }

    // In-memory/test runtime path. Production config requires the atomic
    // confirmed-deposit ingest store alongside persistent deposit storage.
    const confirmedAccount = await this.accountStore?.getByAddress(block.recipientAccount);
    const matchingInvoices = await this.invoiceStore.getByPayAddress(block.recipientAccount);
    const confirmedDerivationIndex = confirmedAccount?.derivationIndex
      ?? matchingInvoices[0]?.derivationIndex
      ?? null;
    const invoice = [...matchingInvoices].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    const existingPayment = await this.paymentStore.getByBlockHash(block.blockHash);
    const existingDeposit = await this.depositStore.getByBlockHash(block.blockHash);

    if (confirmedDerivationIndex != null) {
      await this.receiveOrchestrator?.enqueueReceivables(block.recipientAccount, confirmedDerivationIndex);
    }

    const disposition: Deposit['disposition'] = !invoice
      ? 'unmatched'
        : invoice.status !== 'open'
          ? 'late'
          : BigInt(invoice.receivedAmountRaw) + BigInt(block.amountRaw) > BigInt(invoice.expectedAmountRaw)
          ? 'excess'
            : BigInt(invoice.receivedAmountRaw) + BigInt(block.amountRaw) < BigInt(invoice.expectedAmountRaw)
            ? 'partial'
            : 'matched';
    const deposit = await this.depositStore.createIfAbsent({
      id: randomUUID(),
      blockHash: block.blockHash,
      recipientAccount: block.recipientAccount,
      senderAccount: block.senderAccount || null,
      amountRaw: block.amountRaw,
      invoiceId: invoice?.id ?? existingPayment?.invoiceId ?? null,
      disposition: existingDeposit?.disposition ?? disposition,
      confirmedAt: block.confirmedAt,
    });

    if (!existingDeposit) {
      await this.emitV2Event({
        id: randomUUID(),
        type: 'deposit.observed',
        timestamp: block.confirmedAt,
        data: { deposit },
        resourceId: deposit.id,
        resourceType: 'deposit',
      });
    }

    // Idempotency guard: if we already processed this block for invoice matching, skip.
    if (existingPayment === undefined && invoice?.status === 'open') {
      const payment = await this.paymentStore.create({
        id: randomUUID(),
        invoiceId: invoice.id,
        status: 'confirmed',
        blockHash: block.blockHash,
        senderAddress: block.senderAccount || null,
        amountRaw: block.amountRaw,
        confirmedAt: block.confirmedAt,
        detectedAt: block.confirmedAt,
      });

      // Update confirmed amount on the invoice.
      const newConfirmedRaw = (
        BigInt(invoice.receivedAmountRaw) + BigInt(block.amountRaw)
      ).toString();

      const updatedInvoice = await this.invoiceStore.update(invoice.id, {
        receivedAmountRaw: newConfirmedRaw,
      });

      await this.emitV2Event({
        id: randomUUID(),
        type: 'invoice.payment_received',
        timestamp: new Date().toISOString(),
        data: { payment, invoice: updatedInvoice },
        resourceId: invoice.id,
        resourceType: 'invoice',
      });

      await this.emitV2Event({
        id: randomUUID(),
        type: 'invoice.payment_confirmed',
        timestamp: new Date().toISOString(),
        data: { payment, invoice: updatedInvoice },
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
          data: { invoice: completedInvoice },
          resourceId: completedInvoice.id,
          resourceType: 'invoice',
        });
      }
    }

  }

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  private async runExpiryCheck(): Promise<void> {
    const now = new Date().toISOString();
    const openInvoices = await this.invoiceStore.list({ status: 'open' });

    for (const invoice of openInvoices) {
      if (invoice.expiresAt !== null && invoice.expiresAt <= now) {
        const updated = await this.invoiceStore.transition(invoice.id, 'open', {
          status: 'expired',
        });
        if (!updated) continue;

        await this.emitV2Event({
          id: randomUUID(),
          type: 'invoice.expired',
          timestamp: new Date().toISOString(),
          data: { invoice: updated },
          resourceId: updated.id,
          resourceType: 'invoice',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  private async emitV2Event(event: RaiFlowEvent): Promise<void> {
    await this.eventStore.append(event);
    await this.dispatchV2Event(event);
  }

  private async dispatchV2Event(event: RaiFlowEvent): Promise<void> {
    // Notify local listeners (fire-and-forget).
    const targets = [
      ...(this.listeners.get(event.type as RaiFlowEventType) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    for (const fn of targets) {
      try {
      void Promise.resolve(fn(event)).catch(() => {});
      } catch {
        // Swallow sync throws from listener
      }
    }

    if (this.webhookOutboxWorker) this.webhookOutboxWorker.wake();
    else {
      const endpoints = await this.webhookEndpointStore.getByEventType(event.type);
      void this.webhookDelivery.deliver(event, endpoints).catch(() => {});
    }
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
