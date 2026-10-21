import type { InvoiceStatus, RaiFlowEventType, WatcherSink, ConfirmedBlock, CompletionPolicy, LegacyInvoiceStore, LegacyPaymentStore, LegacyEventStore, LegacyRaiFlowEvent, WebhookEndpointStore, Account, AccountStore, AccountType, Send, SendStore, RaiFlowEvent, EventStore, IdempotencyReplayStore, Invoice, Payment, EventQueryOptions, PaginatedEventsResponse, InvoiceAccountStore, ReceiveTaskStore } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool, RpcPoolState } from '@openrai/rpc';
import type { RunMode } from '@openrai/config';
import { type WebhookDelivery } from '@openrai/webhook';
export type EventListener = (event: LegacyRaiFlowEvent) => void | Promise<void>;
export interface WatcherLike {
    addAccount(account: string): void;
    removeAccount(account: string): void;
}
/**
 * Convert a human-readable XNO amount string to raw (the smallest Nano unit).
 * Uses string manipulation + BigInt to avoid floating-point precision loss.
 *
 * @example xnoToRaw("1")      // "1000000000000000000000000000000"
 * @example xnoToRaw("0.001")  // "1000000000000000000000000000"
 */
export declare function xnoToRaw(xno: string): string;
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
export declare class Runtime implements WatcherSink {
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
    private readonly v2EventStore?;
    private readonly invoiceDerivationStartIndex;
    private readonly managedDerivationStartIndex;
    private readonly webhookDelivery;
    private readonly expiryIntervalMs;
    private readonly blockConfirmationIntervalMs;
    private readonly blockConfirmationTimeoutMs;
    private expiryTimer;
    private readonly blockConfirmationTimers;
    private readonly confirmingBlocks;
    private invoiceAccountStore?;
    private receiveTaskStore?;
    private receiveOrchestrator?;
    private receiveWorkerInterval?;
    private receiveRecoveryInterval?;
    private readonly listeners;
    private readonly sendOrchestrator?;
    private readonly processingConfirmedBlocks;
    private readonly processedConfirmedBlocks;
    watcher?: WatcherLike;
    constructor(config?: RuntimeConfig);
    /** Start the expiry scheduler and send orchestrator. */
    start(): void;
    /** Stop the expiry scheduler, send orchestrator, and shut down webhook delivery. */
    stop(): void;
    createInvoice(params: {
        /** Amount in raw (string). Provide this or `expectedAmount`. */
        expectedAmountRaw?: string;
        /** Amount in XNO (human-readable). Converted to raw via `xnoToRaw`. */
        expectedAmount?: string;
        accountKey: string;
        invoiceKey?: string;
        expiresAt?: string;
        metadata?: Record<string, unknown>;
        completionPolicy?: CompletionPolicy;
    }, idempotencyKey?: string): Promise<Invoice>;
    getInvoice(id: string): Promise<Invoice | undefined>;
    /** Resolve one invoice without scanning the account's invoice list. */
    getInvoiceByAccountKeyAndInvoiceKey(accountKey: string, invoiceKey: string | null): Promise<Invoice | undefined>;
    listInvoices(filter?: {
        status?: InvoiceStatus;
    }): Promise<Invoice[]>;
    getInvoicesByAccountKey(accountKey: string): Promise<Invoice[]>;
    getInvoiceAccountBalance(accountKey: string, invoiceKey: string | null): Promise<{
        balanceRaw: string;
        pendingRaw: string;
        address: string;
    } | undefined>;
    getInvoiceAccountAggregatedBalance(accountKey: string): Promise<{
        confirmedAmountRaw: string;
        pendingAmountRaw: string;
        invoiceCount: number;
        addresses: string[];
    }>;
    cancelInvoice(id: string, idempotencyKey?: string): Promise<Invoice>;
    private persistAccount;
    createManagedAccount(params: {
        accountKey: string;
        label?: string;
        representative?: string;
        idempotencyKey?: string;
    }): Promise<Account>;
    createWatchedAccount(params: {
        address: string;
        label?: string;
        idempotencyKey: string;
    }): Promise<Account>;
    listAccounts(filter?: {
        type?: AccountType;
    }): Promise<Account[]>;
    getAccount(id: string): Promise<Account | undefined>;
    updateAccount(id: string, patch: {
        label?: string;
        representative?: string;
    }, idempotencyKey: string): Promise<Account>;
    deleteAccount(id: string, idempotencyKey: string): Promise<Account | undefined>;
    queueSend(params: {
        accountId: string;
        destination: string;
        amountRaw: string;
        idempotencyKey: string;
    }): Promise<Send>;
    listSendsByAccount(accountId: string): Promise<Send[]>;
    getSend(id: string): Promise<Send | undefined>;
    getPaymentsByInvoice(invoiceId: string): Promise<Payment[]>;
    getEventsByInvoice(invoiceId: string, options?: {
        after?: string;
    }): Promise<LegacyRaiFlowEvent[] | RaiFlowEvent[]>;
    listEvents(options?: EventQueryOptions): Promise<PaginatedEventsResponse>;
    createWebhookEndpoint(input: Parameters<WebhookEndpointStore['create']>[0], idempotencyKey?: string): Promise<import("@openrai/model").WebhookEndpoint>;
    deleteWebhookEndpoint(id: string, idempotencyKey?: string): Promise<boolean>;
    publishBlock(block: string, idempotencyKey?: string): Promise<{
        hash: string;
    }>;
    /**
     * Confirm a caller-signed block without requiring the caller to expose keys
     * or maintain a public Nano RPC connection. The RPC pool owns endpoint
     * selection and retries; RaiFlow owns the state transition and event.
     */
    private trackBlockConfirmation;
    /** Re-arm confirmation polling for accepted blocks after a process restart. */
    private recoverBlockConfirmations;
    /**
     * Recover invoice payments whose incoming send was received by RaiFlow but
     * whose watcher event was missed (for example during an RPC outage). The
     * receive task keeps the original pending-send hash, so a confirmed block
     * lookup is enough to replay the normal idempotent invoice transition.
     */
    private recoverReceiveConfirmations;
    recordRpcState(state: RpcPoolState): Promise<void>;
    on(type: RaiFlowEventType | '*', listener: EventListener): void;
    off(type: RaiFlowEventType | '*', listener: EventListener): void;
    handleConfirmedBlock(block: ConfirmedBlock): Promise<void>;
    private ingestConfirmedBlock;
    private runExpiryCheck;
    private emitEvent;
    private emitV2Event;
    private getNextManagedDerivationIndex;
}
