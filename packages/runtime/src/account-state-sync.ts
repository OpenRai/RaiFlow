// @openrai/runtime — Account state sync & reconciliation

import { randomUUID } from 'node:crypto';
import type {
  AccountStore,
  AccountEvent,
  WatcherSink,
  ConfirmedBlock,
} from '@openrai/model';
import type { RpcPool } from '@openrai/rpc';
import type { WatcherLike } from './runtime.js';

export interface AccountStateSyncOptions {
  reconcileIntervalMs?: number;
  initialSyncDelayMs?: number;
}

export class AccountStateSync implements WatcherSink {
  private readonly watchedAccounts = new Map<string, { id: string }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly reconcileIntervalMs: number;
  private readonly initialSyncDelayMs: number;

  constructor(
    private readonly rpcPool: RpcPool,
    private readonly accountStore: AccountStore,
    private readonly watcher: WatcherLike,
    private readonly onAccountEvent?: (event: AccountEvent) => void,
    private readonly forwardBlock?: (block: ConfirmedBlock) => Promise<void>,
    options?: AccountStateSyncOptions,
  ) {
    this.reconcileIntervalMs = options?.reconcileIntervalMs ?? 30_000;
    this.initialSyncDelayMs = options?.initialSyncDelayMs ?? 750;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Account management
  // -----------------------------------------------------------------------

  async addAccount(address: string): Promise<void> {
    const account = await this.accountStore.getByAddress(address);
    if (!account) return;

    this.watchedAccounts.set(address, { id: account.id });
    this.watcher.addAccount(address);
    try {
      await this.initialSync(address, account.id);
    } catch (err) {
      console.warn(
        `[account-state-sync] failed to sync ${address} on add:`,
        err instanceof Error ? err.message : err,
      );
    }
    if (this.initialSyncDelayMs > 0) {
      await this.sleep(this.initialSyncDelayMs);
    }
  }

  removeAccount(address: string): void {
    this.watchedAccounts.delete(address);
    this.watcher.removeAccount(address);
  }

  // -----------------------------------------------------------------------
  // WatcherSink — real-time confirmed blocks
  // -----------------------------------------------------------------------

  async handleConfirmedBlock(block: ConfirmedBlock): Promise<void> {
    const entry = this.watchedAccounts.get(block.recipientAccount);
    if (entry) {
      const account = await this.accountStore.get(entry.id);
      if (account) {
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

    // Forward to Runtime for invoice matching and send confirmation
    if (this.forwardBlock) {
      await this.forwardBlock(block);
    }
  }

  // -----------------------------------------------------------------------
  // Periodic reconciliation
  // -----------------------------------------------------------------------

  private async reconcile(): Promise<void> {
    for (const [address, { id }] of this.watchedAccounts) {
      try {
        await this.reconcileAccount(address, id);
      } catch (err) {
        console.warn(
          `[account-state-sync] reconciliation failed for ${address}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async reconcileAccount(address: string, accountId: string): Promise<void> {
    const client = this.rpcPool.getClient();
    let info: Awaited<ReturnType<typeof client.accountInfo>> | undefined;
    try {
      info = await client.accountInfo(address);
    } catch (err) {
      console.warn(
        `[account-state-sync] reconciliation RPC failed for ${address}:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }
    if (!info) return; // unopened account

    const account = await this.accountStore.get(accountId);
    if (!account) return;

    const updates: Partial<Parameters<AccountStore['update']>[1]> = {};
    const eventData: AccountEvent['data'] = {};

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

    if (Object.keys(updates).length === 0) return;

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

  private async initialSync(address: string, accountId: string): Promise<void> {
    const client = this.rpcPool.getClient();
    let info: Awaited<ReturnType<typeof client.accountInfo>> | null = null;
    try {
      info = await client.accountInfo(address);
    } catch (err) {
      console.warn(
        `[account-state-sync] initial sync RPC failed for ${address}:`,
        err instanceof Error ? err.message : err,
      );
    }

    const account = await this.accountStore.get(accountId);
    if (!account) return;

    const updates: Partial<Parameters<AccountStore['update']>[1]> = {};
    if (info) {
      if (info.balance !== account.balanceRaw) updates.balanceRaw = info.balance;
      if (info.frontier !== account.frontier) updates.frontier = info.frontier;
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

  private emit(event: AccountEvent): void {
    try {
      this.onAccountEvent?.(event);
    } catch {
      // Subscriber errors must not crash the sync loop
    }
  }
}
