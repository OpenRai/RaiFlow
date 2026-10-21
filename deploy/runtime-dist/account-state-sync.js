// @openrai/runtime — Account state sync & reconciliation
import { randomUUID } from 'node:crypto';
export class AccountStateSync {
    rpcPool;
    accountStore;
    watcher;
    onAccountEvent;
    forwardBlock;
    watchedAccounts = new Map();
    timer;
    reconcileIntervalMs;
    initialSyncDelayMs;
    rateLimitBackoffMs;
    /** Timestamp (Date.now()) until which reconciliation is suppressed due to rate-limiting. */
    rateLimitedUntil = 0;
    initialSyncComplete = true;
    constructor(rpcPool, accountStore, watcher, onAccountEvent, forwardBlock, options) {
        this.rpcPool = rpcPool;
        this.accountStore = accountStore;
        this.watcher = watcher;
        this.onAccountEvent = onAccountEvent;
        this.forwardBlock = forwardBlock;
        this.reconcileIntervalMs = options?.reconcileIntervalMs ?? 30_000;
        this.initialSyncDelayMs = options?.initialSyncDelayMs ?? 750;
        this.rateLimitBackoffMs = options?.rateLimitBackoffMs ?? 5 * 60_000;
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------
    start() {
        if (this.timer !== undefined)
            return;
        this.timer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
        if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
            this.timer.unref();
        }
    }
    stop() {
        if (this.timer !== undefined) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    // -----------------------------------------------------------------------
    // Account management
    // -----------------------------------------------------------------------
    async addAccount(address) {
        const account = await this.accountStore.getByAddress(address);
        if (!account)
            return;
        this.watchedAccounts.set(address, { id: account.id });
        this.watcher.addAccount(address);
        try {
            await this.initialSync(address, account.id);
        }
        catch (err) {
            console.warn(`[account-state-sync] failed to sync ${address} on add:`, err instanceof Error ? err.message : err);
        }
        if (this.initialSyncDelayMs > 0) {
            await this.sleep(this.initialSyncDelayMs);
        }
    }
    removeAccount(address) {
        this.watchedAccounts.delete(address);
        this.watcher.removeAccount(address);
    }
    /** Whether all accounts from the current startup restore have been synced. */
    isInitialSyncComplete() {
        return this.initialSyncComplete;
    }
    /** Restore persisted accounts with bounded account_info concurrency. */
    async syncExistingAccounts(addresses, concurrency = 4) {
        if (addresses.length === 0) {
            this.initialSyncComplete = true;
            return { synced: 0, failed: 0 };
        }
        this.initialSyncComplete = false;
        let next = 0;
        let synced = 0;
        let failed = 0;
        const workerCount = Math.min(addresses.length, Math.max(1, Math.floor(concurrency)));
        const worker = async () => {
            for (;;) {
                const index = next++;
                const address = addresses[index];
                if (address === undefined)
                    return;
                try {
                    await this.addAccount(address);
                    synced++;
                }
                catch (err) {
                    failed++;
                    console.warn(`[account-state-sync] failed to restore ${address}:`, err instanceof Error ? err.message : err);
                }
            }
        };
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        this.initialSyncComplete = true;
        return { synced, failed };
    }
    // -----------------------------------------------------------------------
    // WatcherSink — real-time confirmed blocks
    // -----------------------------------------------------------------------
    async handleConfirmedBlock(block) {
        const entry = this.watchedAccounts.get(block.recipientAccount);
        if (entry) {
            const account = await this.accountStore.get(entry.id);
            if (account) {
                // A malformed watcher payload must not turn an unopened-account
                // notification into a process-wide BigInt exception.
                if (!/^\d+$/.test(account.balanceRaw) || !/^\d+$/.test(block.amountRaw)) {
                    console.warn(`[account-state-sync] ignoring malformed balance update for ${block.recipientAccount}`);
                }
                else {
                    const newBalanceRaw = (BigInt(account.balanceRaw) + BigInt(block.amountRaw)).toString();
                    const updated = await this.accountStore.update(account.id, {
                        balanceRaw: newBalanceRaw,
                        frontier: block.blockHash,
                    });
                    this.emit({
                        id: randomUUID(),
                        type: 'account.payment_received',
                        accountId: account.id,
                        accountAddress: account.address,
                        timestamp: new Date().toISOString(),
                        data: {
                            blockHash: block.blockHash,
                            senderAccount: block.senderAccount,
                            amountRaw: block.amountRaw,
                            previousBalanceRaw: account.balanceRaw,
                            newBalanceRaw,
                            previousFrontier: account.frontier,
                            newFrontier: block.blockHash,
                        },
                    });
                }
            }
        }
        // Forward to Runtime for invoice matching and send confirmation
        if (this.forwardBlock) {
            await this.forwardBlock(block);
        }
    }
    // -----------------------------------------------------------------------
    // Periodic reconciliation
    // -----------------------------------------------------------------------
    async reconcile() {
        if (Date.now() < this.rateLimitedUntil) {
            return; // still in rate-limit backoff — skip this cycle entirely
        }
        for (const [address, { id }] of this.watchedAccounts) {
            try {
                await this.reconcileAccount(address, id);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (message.includes('429')) {
                    this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;
                    console.warn(`[account-state-sync] rate limited (429) — pausing reconciliation for ${this.rateLimitBackoffMs / 1000}s`);
                    return; // abort the rest of this reconciliation sweep
                }
                console.warn(`[account-state-sync] reconciliation failed for ${address}:`, message);
            }
        }
    }
    async reconcileAccount(address, accountId) {
        const client = this.rpcPool.getClient();
        let info;
        try {
            info = await client.accountInfo(address);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Re-throw 429s so the outer reconcile() loop can apply backoff.
            if (message.includes('429'))
                throw err;
            console.warn(`[account-state-sync] reconciliation RPC failed for ${address}:`, message);
            return;
        }
        const account = await this.accountStore.get(accountId);
        if (!account)
            return;
        // An unopened account has no confirmed frontier. Never retain a cached
        // frontier/balance from a previously misclassified pending send: doing so
        // would make a client sign a receive block against a block it does not
        // own. Pending funds are reconciled separately by the watcher.
        if (!info) {
            const updates = {};
            if (account.balanceRaw !== '0')
                updates.balanceRaw = '0';
            if (account.frontier !== null)
                updates.frontier = null;
            if (Object.keys(updates).length > 0)
                await this.accountStore.update(accountId, updates);
            return;
        }
        const updates = {};
        const eventData = {};
        if (info.balance !== account.balanceRaw) {
            updates.balanceRaw = info.balance;
            eventData.previousBalanceRaw = account.balanceRaw;
            eventData.newBalanceRaw = info.balance;
        }
        if (info.frontier !== account.frontier) {
            updates.frontier = info.frontier;
            eventData.previousFrontier = account.frontier;
            eventData.newFrontier = info.frontier;
        }
        if (Object.keys(updates).length === 0)
            return;
        await this.accountStore.update(accountId, updates);
        this.emit({
            id: randomUUID(),
            type: eventData.newBalanceRaw !== undefined ? 'account.balance_updated' : 'account.frontier_updated',
            accountId,
            accountAddress: address,
            timestamp: new Date().toISOString(),
            data: eventData,
        });
    }
    // -----------------------------------------------------------------------
    // Initial sync
    // -----------------------------------------------------------------------
    async initialSync(address, accountId) {
        const client = this.rpcPool.getClient();
        let info = null;
        try {
            info = await client.accountInfo(address);
        }
        catch (err) {
            console.warn(`[account-state-sync] initial sync RPC failed for ${address}:`, err instanceof Error ? err.message : err);
        }
        const account = await this.accountStore.get(accountId);
        if (!account)
            return;
        const updates = {};
        if (info) {
            if (info.balance !== account.balanceRaw)
                updates.balanceRaw = info.balance;
            if (info.frontier !== account.frontier)
                updates.frontier = info.frontier;
        }
        else {
            // Account-not-found means the account is unopened; clear any stale
            // cached frontier so clients can construct the open receive block.
            if (account.balanceRaw !== '0')
                updates.balanceRaw = '0';
            if (account.frontier !== null)
                updates.frontier = null;
        }
        const updated = Object.keys(updates).length > 0
            ? await this.accountStore.update(accountId, updates)
            : account;
        this.emit({
            id: randomUUID(),
            type: 'account.state_synced',
            accountId,
            accountAddress: address,
            timestamp: new Date().toISOString(),
            data: {
                snapshot: {
                    balanceRaw: updated.balanceRaw,
                    frontier: updated.frontier,
                    representative: updated.representative,
                    blockCount: info?.blockCount ?? 0,
                },
            },
        });
    }
    // -----------------------------------------------------------------------
    // Emit helper
    // -----------------------------------------------------------------------
    emit(event) {
        try {
            this.onAccountEvent?.(event);
        }
        catch {
            // Subscriber errors must not crash the sync loop
        }
    }
}
//# sourceMappingURL=account-state-sync.js.map