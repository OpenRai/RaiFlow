/**
 * @openrai/watcher — src/websocket.ts
 *
 * Real-time confirmed block subscription using the global WebSocket API.
 * Requires Node 21+ (built-in WebSocket) or a runtime that exposes a
 * compliant global `WebSocket` constructor.
 *
 * Subscribes to the Nano node's `confirmation` topic and detects incoming
 * sends to watched accounts by inspecting `block.link_as_account` for send
 * subtype blocks — the observe-mode pattern where we hold no private keys.
 *
 * No external dependencies.
 */

import { NanoClient } from '@openrai/nano-core';
import type { EndpointAuditRecord } from '@openrai/nano-core/transport';
import type { ConfirmedBlock, WatcherSink } from '@openrai/model';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NanoWebSocketConfig {
  /** WebSocket URL of the Nano node, e.g. "ws://localhost:7078" */
  url?: string;
  /** Milliseconds to wait before attempting a reconnect. Default: 5000 */
  reconnectIntervalMs?: number;
  /** Maximum number of reconnection attempts. Default: Infinity */
  maxReconnectAttempts?: number;
}

// ---------------------------------------------------------------------------
// Nano WebSocket message shapes
// ---------------------------------------------------------------------------

interface WsConfirmationBlock {
  type: string;
  subtype?: string;
  account: string;
  link_as_account?: string;
}

interface WsConfirmationMessage {
  account: string;
  amount: string;
  hash: string;
  block: WsConfirmationBlock;
}

interface WsMessage {
  topic: string;
  time?: string;
  message: WsConfirmationMessage;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NanoWebSocketClient {
  private readonly client: NanoClient;
  private readonly baseReconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;

  private ws: WebSocket | null = null;
  private sink: WatcherSink | null = null;
  private watchedAccounts: Set<string> = new Set();
  private reconnectAttempts = 0;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: NanoWebSocketConfig) {
    this.client = NanoClient.initialize({
      ...(config.url ? { ws: [config.url] } : {}),
    });
    this.baseReconnectIntervalMs = config.reconnectIntervalMs ?? 5_000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? Infinity;
  }

  getAuditReport(): EndpointAuditRecord[] {
    return this.client.wsPool.getAuditReport();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Connect and start forwarding confirmed blocks to the given sink. */
  connect(sink: WatcherSink, accounts: string[]): void {
    this.sink = sink;
    this.watchedAccounts = new Set(accounts);
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  /** Gracefully close the connection and stop reconnecting. */
  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic subscription management
  // -------------------------------------------------------------------------

  /** Add an account to the watched set and update the node subscription. */
  addAccount(account: string): void {
    if (this.watchedAccounts.has(account)) return;
    this.watchedAccounts.add(account);
    this.resubscribe();
  }

  /** Remove an account from the watched set and update the node subscription. */
  removeAccount(account: string): void {
    if (!this.watchedAccounts.has(account)) return;
    this.watchedAccounts.delete(account);
    this.resubscribe();
  }

  // -------------------------------------------------------------------------
  // Private: socket management
  // -------------------------------------------------------------------------

  private getReconnectDelay(): number {
    // Exponential backoff: base * 2^attempts, capped at some maximum
    const delay = Math.min(
      this.baseReconnectIntervalMs * Math.pow(1.5, this.reconnectAttempts),
      60_000, // Max 60 seconds
    );
    return delay;
  }

  private openSocket(): void {
    void this.establishSocket();
  }

  private async establishSocket(): Promise<void> {
    try {
      this.ws = await this.client.wsPool.connect();
    } catch {
      this.scheduleReconnect();
      return;
    }

    if (!this.ws) {
      this.scheduleReconnect();
      return;
    }

    this.reconnectAttempts = 0;
    this.sendSubscription();

    this.ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener('close', () => {
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    });

    this.ws.addEventListener('error', () => {
      // 'error' is always followed by 'close'; reconnection handled there.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    this.reconnectAttempts++;
    const delay = this.getReconnectDelay();
    console.debug(`[ws-client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.openSocket();
      }
    }, delay);
  }

  private sendSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const accounts = Array.from(this.watchedAccounts);
    const subscribeMsg =
      accounts.length > 0
        ? {
            action: 'subscribe',
            topic: 'confirmation',
            options: {
              // Subscribe to all confirmations; we'll client-side filter for
              // sends to our watched accounts (observe mode, no private keys).
              // Some nodes support accounts_filter which fires for blocks ON
              // those accounts but we need the broader stream for inbound sends.
              all_local_accounts: false,
            },
          }
        : {
            action: 'subscribe',
            topic: 'confirmation',
          };

    this.ws.send(JSON.stringify(subscribeMsg));
  }

  private resubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Re-send the subscription message; the node will replace the existing one.
    this.sendSubscription();
  }

  // -------------------------------------------------------------------------
  // Private: message parsing
  // -------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let parsed: WsMessage;
    try {
      parsed = JSON.parse(raw) as WsMessage;
    } catch {
      return; // ignore malformed frames
    }

    if (parsed.topic !== 'confirmation') return;

    const msg = parsed.message;
    const block = msg?.block;
    if (!msg || !block) return;

    // We only care about state send blocks.
    if (block.subtype !== 'send') return;

    // The recipient is carried in link_as_account.
    const recipient = block.link_as_account;
    if (!recipient) return;

    // Filter to only the accounts we're watching.
    if (!this.watchedAccounts.has(recipient)) return;

    const confirmedBlock: ConfirmedBlock = {
      blockHash: msg.hash,
      senderAccount: msg.account,
      recipientAccount: recipient,
      amountRaw: msg.amount,
      confirmedAt: parsed.time ? new Date(Number(parsed.time)).toISOString() : new Date().toISOString(),
    };

    this.sink?.handleConfirmedBlock(confirmedBlock).catch(() => {
      // Sink errors should not crash the watcher; callers are responsible
      // for error handling inside their sink implementation.
    });
  }
}
