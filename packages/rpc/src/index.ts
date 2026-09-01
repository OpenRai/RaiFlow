// @openrai/rpc — Multi-node RPC, WebSocket, failover, and confirmation tracking

import { NanoClient } from '@openrai/nano-core';
import type { EndpointAuditRecord } from '@openrai/nano-core/transport';
import type { ConfirmedBlock } from '@openrai/model';
import { generateWork as rspowGenerate, WorkType } from 'nano-rspow-node';

export interface RpcNodeConfig {
  rpc: string[];
  ws: string[];
}

export interface RpcClient {
  healthCheck(): Promise<void>;
  accountInfo(account: string): Promise<AccountInfoResponse | undefined>;
  accountsReceivable(account: string): Promise<Receivable[]>;
  /** Read confirmation state for a published block. */
  blockInfo(hash: string): Promise<BlockInfoResponse | undefined>;
  process(block: string): Promise<ProcessResponse>;
  workGenerate(hash: string): Promise<WorkGenerateResponse>;
  getAuditReport(): EndpointAuditRecord[];
}

export interface AccountInfoResponse {
  frontier: string;
  balance: string;
  representative: string;
  blockCount: number;
}

export interface Receivable {
  hash: string;
  amount: string;
  sender: string;
}

export interface ProcessResponse {
  hash: string;
}

export interface BlockInfoResponse {
  confirmed: boolean;
  subtype?: string;
  blockAccount?: string;
  amount?: string;
  localTimestamp?: string;
}

export interface WorkGenerateResponse {
  work: string;
}

export interface RpcPool {
  getClient(): RpcClient;
  addNode(config: RpcNodeConfig): void;
  removeNode(rpcUrl: string): void;
  getActiveNode(): RpcClient | undefined;
  onStateChange(listener: (state: RpcPoolState) => void): () => void;
  getAuditReport(): EndpointAuditRecord[];
}

export interface RpcPoolState {
  status: 'connected' | 'disconnected' | 'failover';
  activeNode?: RpcNodeConfig;
  previousNode?: RpcNodeConfig;
}

function nodeFromRpcUrl(nodes: RpcNodeConfig[], rpcUrl: string): RpcNodeConfig | undefined {
  return nodes.find((node) => node.rpc.includes(rpcUrl));
}

function configuredRpcUrls(nodes: RpcNodeConfig[]): string[] {
  return nodes.flatMap((node) => node.rpc);
}

function configuredWsUrls(nodes: RpcNodeConfig[]): string[] {
  return nodes.flatMap((node) => node.ws);
}


/**
 * A simple promise-based semaphore for limiting concurrency.
 * Callers acquire a slot (waiting if all slots are taken) and release when done.
 */
class Semaphore {
  private readonly queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

class PooledRpcClient implements RpcClient {
  constructor(
    private readonly client: NanoClient,
    private readonly semaphore: Semaphore,
  ) {}

  /**
   * Low-level RPC call that returns raw JSON responses without throwing on
   * application-level errors (e.g. "Account not found"). Only transport errors
   * (HTTP failures, network errors, timeouts) propagate as exceptions and are
   * recorded by the EndpointPool.
   *
   * This prevents Nano RPC application errors from poisoning the endpoint pool's
   * cooldown state — which would otherwise cause "All endpoints exhausted" cascades.
   *
   * Requests are serialized through a semaphore sized to the number of configured
   * endpoints, so a single-endpoint pool never overwhelms the EndpointPool with
   * concurrent failures that trigger cascading cooldown exhaustion.
   */
  private async rpcCall<T extends Record<string, unknown>>(
    body: Record<string, unknown>,
  ): Promise<T> {
    await this.semaphore.acquire();
    try {
      return await this._rpcCallInner<T>(body);
    } finally {
      this.semaphore.release();
    }
  }

  private async _rpcCallInner<T extends Record<string, unknown>>(
    body: Record<string, unknown>,
  ): Promise<T> {
    // Access the internal EndpointPool and timeout from the HttpEndpointPool.
    // These are public fields in nano-core's compiled output.
    const rpcPool = this.client.rpcPool as unknown as {
      pool: { execute: <R>(attempt: (endpoint: unknown) => Promise<R>) => Promise<R> };
      timeoutMs: number | null;
    };
    const endpointPool = rpcPool.pool;
    const timeoutMs = rpcPool.timeoutMs;

    return endpointPool.execute(async (ep: unknown) => {
      const endpoint = ep as {
        url: URL;
        auth: { type: string; value?: string; policy?: string };
      };

      // Build headers (mirrors nano-core's buildHeaders logic)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (endpoint.auth.type === 'api-key' && endpoint.auth.value) {
        if (endpoint.auth.policy === 'basic-header') {
          headers['Authorization'] = `Basic ${btoa(`${endpoint.auth.value}:`)}`;
        } else {
          headers['Authorization'] = `Bearer ${endpoint.auth.value}`;
        }
      }

      const controller = timeoutMs !== null ? new AbortController() : null;
      const timer = controller && timeoutMs !== null
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

      let response: Response;
      try {
        response = await fetch(endpoint.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(controller ? { signal: controller.signal } : {}),
        });
      } finally {
        if (timer !== null) clearTimeout(timer);
      }

      if (!response.ok) {
        // Hosted providers sometimes return a Nano application error (for
        // example, an unsupported action) with HTTP 500. Preserve that JSON
        // so the operation-level adapter can apply a protocol fallback. A
        // 429 remains a transport/rate-limit failure for endpoint backoff.
        if (response.status !== 429) {
          const payload = await response.json().catch(() => undefined);
          if (payload && typeof payload === 'object' && 'error' in payload) {
            return payload as T;
          }
        }
        throw new Error(`HTTP error ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as T;
      // Providers commonly report rate limiting as an HTTP-200 Nano RPC
      // payload (`{"error":429}`) rather than an HTTP 429 response. Treat
      // that as endpoint failure so the pool can fail over instead of leaking
      // an application error to every caller.
      if (json && (json as Record<string, unknown>).error === 429) {
        throw new Error('HTTP error 429 rate limited');
      }
      // Return the raw JSON — including any `error` field.
      // The caller decides how to handle application-level errors.
      // Transport errors (above) are the only ones that poison the pool.
      return json;
    });
  }

  async healthCheck(): Promise<void> {
    const result = await this.rpcCall<Record<string, unknown>>({ action: 'version' });
    if (result.error) throw new Error(`version error: ${String(result.error)}`);
    if (typeof result.node_vendor !== 'string' || result.node_vendor.length === 0) {
      throw new Error('version error: response did not include node_vendor');
    }
  }

  async accountInfo(account: string): Promise<AccountInfoResponse | undefined> {
    const result = await this.rpcCall<Record<string, unknown>>({
      action: 'account_info',
      account,
      representative: true,
      confirmed: true,
    });
    // "Account not found" is a valid Nano RPC response for unopened accounts.
    if (result.error === 'Account not found') return undefined;
    if (result.error) {
      throw new Error(`account_info error: ${result.error}`);
    }
    return result as unknown as AccountInfoResponse;
  }

  async accountsReceivable(account: string): Promise<Receivable[]> {
    const result = await this.rpcCall<Record<string, unknown>>({
      action: 'accounts_receivable',
      accounts: [account],
      source: true,
      include_only_confirmed: false,
    });
    // Some hosted Nano providers intentionally disable the newer
    // accounts_receivable action while retaining the equivalent pending query.
    // Keep that provider quirk behind RaiFlow's state-aware RPC boundary.
    // "Account not found" simply means zero receivable blocks.
    if (result.error === 'Account not found') return [];
    if (result.error && /not allowed|unknown action/i.test(String(result.error))) {
      const pending = await this.rpcCall<Record<string, unknown>>({
        action: 'pending',
        account,
        source: true,
        include_only_confirmed: false,
        count: 20,
      });
      if (pending.error === 'Account not found') return [];
      if (pending.error) throw new Error(`pending error: ${pending.error}`);
      const pendingBlocks = pending.blocks as Record<string, { amount: string; source?: string; sender?: string }> | undefined;
      if (!pendingBlocks || typeof pendingBlocks !== 'object') return [];
      return Object.entries(pendingBlocks).map(([hash, block]) => ({
        hash,
        amount: block.amount,
        sender: block.source ?? block.sender ?? '',
      }));
    }
    if (result.error) {
      throw new Error(`accounts_receivable error: ${result.error}`);
    }

    const rawBlocks = result.blocks as Record<string, unknown> | undefined;
    if (!rawBlocks) return [];
    // The Nano RPC `accounts_receivable` response is account-scoped:
    // { blocks: { [account]: { [hash]: { amount, source } } } }. Some
    // providers return the inner hash map directly, so accept both forms at
    // this boundary and never leak the account address as a block hash.
    const nested = rawBlocks[account];
    const blocks = (nested && typeof nested === 'object' ? nested : rawBlocks) as Record<string, unknown>;

    return Object.entries(blocks).flatMap(([hash, value]) => {
      if (!value || typeof value !== 'object') return [];
      const block = value as { amount?: unknown; sender?: unknown; source?: unknown };
      if (typeof block.amount !== 'string') return [];
      return [{
        hash,
        amount: block.amount,
        sender: typeof block.sender === 'string' ? block.sender : typeof block.source === 'string' ? block.source : '',
      }];
    });
  }

  async process(block: string): Promise<ProcessResponse> {
    const result = await this.rpcCall<Record<string, unknown>>({ action: 'process', block });
    if (result.error) throw new Error(`process error: ${String(result.error)}`);
    if (typeof result.hash !== 'string' || result.hash.length === 0) {
      throw new Error('process error: response did not include a block hash');
    }
    return { hash: result.hash };
  }

  async blockInfo(hash: string): Promise<BlockInfoResponse | undefined> {
    const result = await this.rpcCall<Record<string, unknown>>({
      action: 'block_info',
      hash,
      json_block: true,
    });
    // A block can be accepted by a node before it is visible to every
    // confirmation query. Treat that normal propagation window as unknown.
    if (result.error && /block not found|not found/i.test(String(result.error))) {
      return undefined;
    }
    if (result.error) {
      throw new Error(`block_info error: ${String(result.error)}`);
    }
    const confirmed = result.confirmed === true || result.confirmed === 'true' || result.confirmed === '1';
    return {
      confirmed,
      ...(typeof result.subtype === 'string' ? { subtype: result.subtype } : {}),
      ...(typeof result.block_account === 'string' ? { blockAccount: result.block_account } : {}),
      ...(typeof result.amount === 'string' ? { amount: result.amount } : {}),
      ...(typeof result.local_timestamp === 'string' ? { localTimestamp: result.local_timestamp } : {}),
    };
  }

  async workGenerate(hash: string): Promise<WorkGenerateResponse> {
    return { work: await rspowGenerate(hash, WorkType.Send) };
  }

  getAuditReport(): EndpointAuditRecord[] {
    return this.client.rpcPool.getAuditReport();
  }
}

export function createRpcPool(nodes: RpcNodeConfig[]): RpcPool {
  const stateListeners = new Set<(state: RpcPoolState) => void>();
  let currentState: RpcPoolState = { status: 'disconnected' };
  let detachEndpointListener = () => {};
  let client = NanoClient.initialize(buildClientOptions(nodes));

  // One semaphore slot per configured RPC endpoint (minimum 1).
  // This serialises concurrent callers against the pool so a single-endpoint
  // setup never fans out more requests than it can handle, which would trigger
  // cascading cooldown exhaustion ("All endpoints exhausted").
  let semaphore = new Semaphore(Math.max(1, configuredRpcUrls(nodes).length));

  function buildClientOptions(configuredNodes: RpcNodeConfig[]) {
    const rpc = configuredRpcUrls(configuredNodes);
    const ws = configuredWsUrls(configuredNodes);
    return {
      ...(rpc.length > 0 ? { rpc } : {}),
      ...(ws.length > 0 ? { ws } : {}),
    };
  }

  function refreshClient(): void {
    detachEndpointListener();
    client = NanoClient.initialize(buildClientOptions(nodes));
    semaphore = new Semaphore(Math.max(1, configuredRpcUrls(nodes).length));
    detachEndpointListener = client.onEndpointChange((event) => {
      if (event.kind !== 'rpc') return;

      const activeNode = nodeFromRpcUrl(nodes, event.activeUrl);
      const previousNode = event.previousUrl ? nodeFromRpcUrl(nodes, event.previousUrl) : undefined;
      currentState = {
        status: event.status,
        ...(activeNode ? { activeNode } : {}),
        ...(previousNode ? { previousNode } : {}),
      };
      for (const listener of stateListeners) listener(currentState);
    });
  }

  refreshClient();

  function buildClient(): RpcClient {
    return new PooledRpcClient(client, semaphore);
  }

  return {
    getClient(): RpcClient {
      return buildClient();
    },

    addNode(config: RpcNodeConfig): void {
      const existing = nodes.findIndex((n) => n.rpc.some((url) => config.rpc.includes(url)));
      if (existing >= 0) nodes[existing] = config;
      else nodes.push(config);
      refreshClient();
    },

    removeNode(rpcUrl: string): void {
      const idx = nodes.findIndex((n) => n.rpc.includes(rpcUrl));
      if (idx < 0) return;
      nodes.splice(idx, 1);
      refreshClient();
      if (nodes.length === 0 && client.getAuditReport().rpc.length === 0) {
        currentState = { status: 'disconnected' };
        for (const listener of stateListeners) listener(currentState);
      }
    },

    getActiveNode(): RpcClient | undefined {
      if (configuredRpcUrls(nodes).length === 0 && client.getAuditReport().rpc.length === 0) return undefined;
      return buildClient();
    },

    onStateChange(listener: (state: RpcPoolState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    getAuditReport(): EndpointAuditRecord[] {
      return client.rpcPool.getAuditReport();
    },
  };
}

export interface WsClient {
  connect(accounts: string[]): Promise<void>;
  disconnect(): void;
  addAccount(account: string): void;
  removeAccount(account: string): void;
  onConfirmation(listener: (block: ConfirmedBlock) => void): () => void;
  getAuditReport(): EndpointAuditRecord[];
}

export function createWsClient(wsUrl?: string): WsClient {
  const client = NanoClient.initialize({
    ...(wsUrl ? { ws: [wsUrl] } : {}),
  });

  let ws: WebSocket | null = null;
  const accounts = new Set<string>();
  const confirmationListeners = new Set<(block: ConfirmedBlock) => void>();

  async function establish(): Promise<void> {
    ws = await client.wsPool.connect();
    const socket = ws;
    if (!socket) throw new Error('WebSocket connection failed');
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        if (msg.topic === 'confirmation' && msg.message) {
          const m = msg.message as Record<string, unknown>;
          const block = m.block as Record<string, unknown> | undefined;
          if (!block) return;
          const confirmedBlock: ConfirmedBlock = {
            blockHash: block.hash as string,
            senderAccount: (block.account as string) ?? '',
            recipientAccount: (block.contents as string) ?? '',
            amountRaw: m.amount as string,
            confirmedAt: new Date().toISOString(),
          };
          for (const listener of confirmationListeners) listener(confirmedBlock);
        }
      } catch {
        // ignore parse errors
      }
    };
  }

  return {
    async connect(accounts_: string[]): Promise<void> {
      for (const account of accounts_) accounts.add(account);
      await establish();

      if (ws && accounts.size > 0) {
        ws.send(JSON.stringify({
          action: 'subscribe',
          topic: 'confirmation',
          options: { accounts: [...accounts], include_block: true },
        }));
      }
    },

    disconnect(): void {
      if (ws) ws.close();
      ws = null;
    },

    addAccount(account: string): void {
      accounts.add(account);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'subscribe',
          topic: 'confirmation',
          options: { accounts: [account], include_block: true },
        }));
      }
    },

    removeAccount(account: string): void {
      accounts.delete(account);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          action: 'unsubscribe',
          topic: 'confirmation',
          options: { accounts: [account] },
        }));
      }
    },

    onConfirmation(listener: (block: ConfirmedBlock) => void): () => void {
      confirmationListeners.add(listener);
      return () => confirmationListeners.delete(listener);
    },

    getAuditReport(): EndpointAuditRecord[] {
      return client.wsPool.getAuditReport();
    },
  };
}
