/**
 * @openrai/watcher — src/watcher.ts
 *
 * Main orchestrator. Combines real-time WebSocket confirmations with RPC
 * receivable discovery and bounded account-history recovery.
 *
 * If WebSocket is unavailable, RPC discovery still delivers confirmed sends.
 *
 * No external dependencies.
 */

import type { WatcherSink } from '@openrai/model';
import type { RpcClient } from '@openrai/rpc';
import { NanoRpcClient } from './rpc.js';
import { NanoWebSocketClient } from './websocket.js';
import { NanoPoller } from './poller.js';
import { AccountHistoryRecovery, createInMemoryRecoveryCursorStore } from './recovery.js';
import type { RecoveryCursorStore } from './recovery.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WatcherConfig {
  /**
   * WebSocket URL of the Nano node, e.g. "ws://localhost:7078".
   * If provided, the watcher uses real-time WebSocket mode.
   * Requires Node 21+ (global WebSocket) or a compatible runtime.
   */
  wsUrl?: string;
  /**
   * HTTP RPC URL of the Nano node, e.g. "http://localhost:7076".
   * Optional. When omitted, nano-core default RPC endpoints are used. RPC
   * discovery and account-history recovery run alongside WebSocket mode.
   */
  rpcUrl?: string;
  /** HTTP RPC URLs used as a failover pool for polling and reconciliation. */
  rpcUrls?: string[];
  /** Reuse the runtime RPC pool for shared auth, failover, and rate-limit policy. */
  rpcClient?: RpcClient;
  /** Accounts to watch for incoming confirmed sends. */
  accounts: string[];
  /** The sink that receives confirmed block events. */
  sink: WatcherSink;
  /** RPC receivable-discovery interval (ms). Default: 5000 */
  pollIntervalMs?: number;
  /** WebSocket reconnect interval (ms). Default: 5000 */
  wsReconnectIntervalMs?: number;
  /** Maximum WebSocket reconnection attempts. Default: Infinity */
  wsMaxReconnectAttempts?: number;
  /** RPC request timeout (ms). Default: 15000 */
  rpcTimeoutMs?: number;
  /** Persistent per-account cursor store for account-history recovery. */
  recoveryCursorStore?: RecoveryCursorStore;
  /** Account-history reconciliation interval (ms). Default: 30000 */
  historyReconcileIntervalMs?: number;
  /** Maximum account-history entries per account and reconciliation pass. Default: 100 */
  historyBatchSize?: number;
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export class Watcher {
  private readonly config: WatcherConfig;
  private readonly rpc: NanoRpcClient;

  private wsClient: NanoWebSocketClient | null = null;
  private poller: NanoPoller | null = null;
  private historyRecovery: AccountHistoryRecovery | null = null;
  private historyTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(config: WatcherConfig) {
    this.config = config;
    this.rpc = new NanoRpcClient({
      rpcClient: config.rpcClient,
      urls: config.rpcUrls,
      url: config.rpcUrl,
      timeoutMs: config.rpcTimeoutMs,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the watcher.
   * Starts RPC receivable discovery and account-history recovery. When
   * configured, WebSocket confirmations run alongside those recovery paths.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.poller = new NanoPoller({
      rpc: this.rpc,
      intervalMs: this.config.pollIntervalMs,
      accounts: [...this.config.accounts],
    });
    this.poller.start(this.config.sink);

    this.historyRecovery = new AccountHistoryRecovery(
      this.rpc,
      this.config.sink,
      this.config.recoveryCursorStore ?? createInMemoryRecoveryCursorStore(),
      this.config.historyBatchSize,
    );
    void this.reconcileHistory();
    this.historyTimer = setInterval(() => void this.reconcileHistory(), this.config.historyReconcileIntervalMs ?? 30_000);
    if (typeof this.historyTimer === 'object' && this.historyTimer !== null && 'unref' in this.historyTimer) {
      (this.historyTimer as NodeJS.Timeout).unref();
    }

    if (this.config.wsUrl) {
      this.wsClient = new NanoWebSocketClient({
        url: this.config.wsUrl,
        reconnectIntervalMs: this.config.wsReconnectIntervalMs,
        maxReconnectAttempts: this.config.wsMaxReconnectAttempts,
        onSubscriptionAck: () => void this.reconcileHistory(),
      });
      this.wsClient.connect(this.config.sink, [...this.config.accounts]);
    }
  }

  /**
   * Stop the watcher and release all resources.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.wsClient?.disconnect();
    this.wsClient = null;

    if (this.historyTimer !== null) {
      clearInterval(this.historyTimer);
      this.historyTimer = null;
    }
    this.historyRecovery = null;

    this.poller?.stop();
    this.poller = null;
  }

  // -------------------------------------------------------------------------
  // Dynamic account management
  // -------------------------------------------------------------------------

  /**
   * Add an account to the watch list.
   * Takes effect immediately on the active transport.
   */
  addAccount(account: string): void {
    if (!this.config.accounts.includes(account)) {
      this.config.accounts.push(account);
    }
    this.wsClient?.addAccount(account);
    this.poller?.addAccount(account);
    void this.historyRecovery?.reconcile(account).catch(() => {});
  }

  /**
   * Remove an account from the watch list.
   * Takes effect immediately on the active transport.
   */
  removeAccount(account: string): void {
    const idx = this.config.accounts.indexOf(account);
    if (idx !== -1) {
      this.config.accounts.splice(idx, 1);
    }
    this.wsClient?.removeAccount(account);
    this.poller?.removeAccount(account);
  }

  private async reconcileHistory(): Promise<void> {
    if (!this.started || !this.historyRecovery) return;
    for (const account of this.config.accounts) {
      try {
        await this.historyRecovery.reconcile(account);
      } catch {
        // Preserve the cursor on failure so the next scheduled pass retries.
      }
    }
  }
}
