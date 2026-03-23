/**
 * @openrai/watcher — src/watcher.ts
 *
 * Main orchestrator. Ties the WebSocket or RPC-polling transport to a
 * WatcherSink, and provides a unified start/stop lifecycle plus dynamic
 * account subscription management.
 *
 * Mode selection:
 *   - If `wsUrl` is provided → WebSocket mode (real-time confirmations)
 *   - Otherwise              → RPC polling mode (periodic `accounts_receivable`)
 *
 * No external dependencies.
 */

import type { WatcherSink } from '@openrai/model';
import { NanoRpcClient } from './rpc.js';
import { NanoWebSocketClient } from './websocket.js';
import { NanoPoller } from './poller.js';

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
   * Required in polling mode. In WebSocket mode it is currently unused
   * but reserved for future initial-sync support.
   */
  rpcUrl: string;
  /** Accounts to watch for incoming confirmed sends. */
  accounts: string[];
  /** The sink that receives confirmed block events. */
  sink: WatcherSink;
  /** Poll interval (ms) when using RPC polling mode. Default: 5000 */
  pollIntervalMs?: number;
  /** WebSocket reconnect interval (ms). Default: 5000 */
  wsReconnectIntervalMs?: number;
  /** Maximum WebSocket reconnection attempts. Default: Infinity */
  wsMaxReconnectAttempts?: number;
  /** RPC request timeout (ms). Default: 15000 */
  rpcTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export class Watcher {
  private readonly config: WatcherConfig;
  private readonly rpc: NanoRpcClient;

  private wsClient: NanoWebSocketClient | null = null;
  private poller: NanoPoller | null = null;
  private started = false;

  constructor(config: WatcherConfig) {
    this.config = config;
    this.rpc = new NanoRpcClient({
      url: config.rpcUrl,
      timeoutMs: config.rpcTimeoutMs,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the watcher.
   * - WebSocket mode: connects and subscribes to confirmation topic.
   * - Polling mode: begins periodic `accounts_receivable` queries.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (this.config.wsUrl) {
      this.wsClient = new NanoWebSocketClient({
        url: this.config.wsUrl,
        reconnectIntervalMs: this.config.wsReconnectIntervalMs,
        maxReconnectAttempts: this.config.wsMaxReconnectAttempts,
      });
      this.wsClient.connect(this.config.sink, [...this.config.accounts]);
    } else {
      this.poller = new NanoPoller({
        rpc: this.rpc,
        intervalMs: this.config.pollIntervalMs,
        accounts: [...this.config.accounts],
      });
      this.poller.start(this.config.sink);
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
}
