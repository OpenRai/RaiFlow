/**
 * @openrai/watcher — src/poller.ts
 *
 * RPC-based polling fallback for Nano nodes without WebSocket support.
 *
 * Uses `accounts_receivable` to detect new pending (inbound) blocks for watched
 * accounts, then calls `block_info` on each to confirm details and emit a
 * `ConfirmedBlock` to the sink. This is the correct observe-mode approach:
 * we don't hold private keys, so we look for pending blocks arriving at our
 * watched addresses rather than tracking the frontier of those accounts.
 *
 * No external dependencies.
 */

import type { ConfirmedBlock, WatcherSink } from '@openrai/model';
import type { NanoRpcClient } from './rpc.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PollerConfig {
  /** The RPC client to use for queries. */
  rpc: NanoRpcClient;
  /** Poll interval in milliseconds. Default: 5000 */
  intervalMs?: number;
  /** Initial set of accounts to watch. */
  accounts: string[];
  /**
   * How long to pause polling after a 429 rate-limit response (ms).
   * Default: 5 minutes.
   */
  rateLimitBackoffMs?: number;
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

export class NanoPoller {
  private readonly rpc: NanoRpcClient;
  private readonly intervalMs: number;
  private readonly rateLimitBackoffMs: number;

  private watchedAccounts: Set<string>;
  private sink: WatcherSink | null = null;

  /** Tracks block hashes we've already emitted to avoid duplicate delivery. */
  private seenHashes: Set<string> = new Set();

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Prevent a slow provider sweep from overlapping the next interval tick. */
  private polling = false;

  /** Timestamp (Date.now()) until which polling is suppressed due to rate-limiting. */
  private rateLimitedUntil = 0;

  constructor(config: PollerConfig) {
    this.rpc = config.rpc;
    this.intervalMs = config.intervalMs ?? 5_000;
    this.rateLimitBackoffMs = config.rateLimitBackoffMs ?? 5 * 60_000;
    this.watchedAccounts = new Set(config.accounts);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start polling and forward confirmed blocks to the given sink. */
  start(sink: WatcherSink): void {
    if (this.running) return;
    this.sink = sink;
    this.running = true;
    // Run once immediately, then on interval.
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);
  }

  /** Stop polling. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sink = null;
  }

  // -------------------------------------------------------------------------
  // Dynamic subscription management
  // -------------------------------------------------------------------------

  addAccount(account: string): void {
    this.watchedAccounts.add(account);
  }

  removeAccount(account: string): void {
    this.watchedAccounts.delete(account);
  }

  // -------------------------------------------------------------------------
  // Private: poll logic
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this.running || this.watchedAccounts.size === 0) return;
    if (this.polling) return;
    this.polling = true;

    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.watchedAccounts.size === 0) return;

    if (Date.now() < this.rateLimitedUntil) {
      return; // still in rate-limit backoff — skip this cycle
    }

    const accounts = Array.from(this.watchedAccounts);

    let receivable: Record<string, string[]>;
    try {
      receivable = await this.rpc.accountsReceivable(accounts, 20);
    } catch (err) {
      // Transient RPC errors should not crash the poller.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('429')) {
        this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;
        console.debug(`[poller] rate limited (429) — pausing for ${this.rateLimitBackoffMs / 1000}s`);
      } else {
        console.debug(`[poller] accounts_receivable RPC failed: ${message}`);
      }
      return;
    }

    for (const [_account, hashes] of Object.entries(receivable)) {
      const hashList = Array.isArray(hashes) ? hashes : Object.keys(hashes);
      for (const hash of hashList) {
        if (this.seenHashes.has(hash)) continue;

        let blockInfo;
        try {
          blockInfo = await this.rpc.blockInfo(hash);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('429')) {
            this.rateLimitedUntil = Date.now() + this.rateLimitBackoffMs;
            console.debug(`[poller] rate limited (429) on block_info — pausing for ${this.rateLimitBackoffMs / 1000}s`);
            return; // abort remainder of this poll cycle
          }
          console.debug(`[poller] block_info RPC failed for ${hash}: ${message}`);
          continue;
        }

        // Only emit confirmed blocks.
        if (!blockInfo.confirmed) continue;
        // Only emit send blocks (these represent incoming payments to our accounts).
        if (blockInfo.subtype !== 'send') continue;

        const recipient = blockInfo.contents.linkAsAccount;
        if (!recipient || !this.watchedAccounts.has(recipient)) continue;

        this.seenHashes.add(hash);

        const confirmedBlock: ConfirmedBlock = {
          blockHash: hash,
          senderAccount: blockInfo.blockAccount,
          recipientAccount: recipient,
          amountRaw: blockInfo.amount,
          confirmedAt: blockInfo.localTimestamp
            ? new Date(Number(blockInfo.localTimestamp) * 1000).toISOString()
            : new Date().toISOString(),
        };

        this.sink?.handleConfirmedBlock(confirmedBlock).catch(() => {
          // Sink errors must not crash the poller.
        });
      }
    }
  }
}
