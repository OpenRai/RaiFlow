import type { AccountStore, AccountEvent, WatcherSink, ConfirmedBlock } from '@openrai/model';
import type { RpcPool } from '@openrai/rpc';
import type { WatcherLike } from './runtime.js';
export interface AccountStateSyncOptions {
    reconcileIntervalMs?: number;
    initialSyncDelayMs?: number;
    /** How long to pause all reconciliation after a 429 rate-limit response (ms). Default: 5 minutes. */
    rateLimitBackoffMs?: number;
}
export declare class AccountStateSync implements WatcherSink {
    private readonly rpcPool;
    private readonly accountStore;
    private readonly watcher;
    private readonly onAccountEvent?;
    private readonly forwardBlock?;
    private readonly watchedAccounts;
    private timer;
    private readonly reconcileIntervalMs;
    private readonly initialSyncDelayMs;
    private readonly rateLimitBackoffMs;
    /** Timestamp (Date.now()) until which reconciliation is suppressed due to rate-limiting. */
    private rateLimitedUntil;
    private initialSyncComplete;
    constructor(rpcPool: RpcPool, accountStore: AccountStore, watcher: WatcherLike, onAccountEvent?: ((event: AccountEvent) => void) | undefined, forwardBlock?: ((block: ConfirmedBlock) => Promise<void>) | undefined, options?: AccountStateSyncOptions);
    private sleep;
    start(): void;
    stop(): void;
    addAccount(address: string): Promise<void>;
    removeAccount(address: string): void;
    /** Whether all accounts from the current startup restore have been synced. */
    isInitialSyncComplete(): boolean;
    /** Restore persisted accounts with bounded account_info concurrency. */
    syncExistingAccounts(addresses: string[], concurrency?: number): Promise<{
        synced: number;
        failed: number;
    }>;
    handleConfirmedBlock(block: ConfirmedBlock): Promise<void>;
    private reconcile;
    private reconcileAccount;
    private initialSync;
    private emit;
}
