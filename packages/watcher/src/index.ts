/**
 * @openrai/watcher
 * Chain observation and confirmation tracking for RaiFlow.
 *
 * Public API surface:
 *
 * Classes:
 *   Watcher            — Main orchestrator (WebSocket or polling mode)
 *   NanoRpcClient      — Typed Nano RPC client (Node built-in fetch)
 *   NanoWebSocketClient — Real-time confirmation subscription (Node 21+ WebSocket)
 *   NanoPoller         — RPC polling fallback for nodes without WebSocket
 *
 * Types:
 *   WatcherConfig
 *   NanoRpcConfig, NanoRpcError
 *   AccountInfo, HistoryBlock, BlockInfo, AccountsReceivable
 *   NanoWebSocketConfig
 *   PollerConfig
 *
 * Re-exported from @openrai/model (for convenience):
 *   ConfirmedBlock, WatcherSink
 */

// Watcher (main orchestrator)
export { Watcher } from './watcher.js';
export type { WatcherConfig } from './watcher.js';

// RPC client
export { NanoRpcClient, NanoRpcError } from './rpc.js';
export type {
  NanoRpcConfig,
  AccountInfo,
  HistoryBlock,
  BlockInfo,
  AccountsReceivable,
} from './rpc.js';

// WebSocket client
export { NanoWebSocketClient } from './websocket.js';
export type { NanoWebSocketConfig } from './websocket.js';

// Poller
export { NanoPoller } from './poller.js';
export type { PollerConfig } from './poller.js';

// Model types re-exported for consumer convenience
export type { ConfirmedBlock, WatcherSink } from '@openrai/model';
