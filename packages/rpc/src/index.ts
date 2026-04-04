// @openrai/rpc — Multi-node RPC, WebSocket, failover, and confirmation tracking

import { HttpEndpointPool } from '@openrai/nano-core/transport/http';
import { WsEndpointPool } from '@openrai/nano-core/transport/ws';
import type { EndpointActivityEvent, EndpointAuditRecord } from '@openrai/nano-core/transport';
import type { ConfirmedBlock } from '@openrai/model';

export interface RpcNodeConfig {
  rpc: string;
  ws: string;
  priority: number;
}

export interface RpcClient {
  accountInfo(account: string): Promise<AccountInfoResponse>;
  accountsReceivable(account: string): Promise<Receivable[]>;
  process(block: string): Promise<ProcessResponse>;
  workGenerate(hash: string, difficulty?: string): Promise<WorkGenerateResponse>;
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
  return nodes.find((node) => node.rpc === rpcUrl);
}

class PooledRpcClient implements RpcClient {
  constructor(private readonly pool: HttpEndpointPool) {}

  async accountInfo(account: string): Promise<AccountInfoResponse> {
    return this.pool.postJson<AccountInfoResponse>({
      action: 'account_info',
      account,
      representative: true,
      confirmed: true,
    });
  }

  async accountsReceivable(account: string): Promise<Receivable[]> {
    const response = await this.pool.postJson<{ blocks: Record<string, { amount: string; sender: string }> }>({
      action: 'accounts_receivable',
      account,
      source: true,
      include_only_confirmed: false,
    });

    return Object.entries(response.blocks).map(([hash, block]) => ({
      hash,
      amount: (block as { amount: string }).amount,
      sender: (block as { sender: string }).sender,
    }));
  }

  async process(block: string): Promise<ProcessResponse> {
    return this.pool.postJson<ProcessResponse>({ action: 'process', block });
  }

  async workGenerate(hash: string, difficulty?: string): Promise<WorkGenerateResponse> {
    return this.pool.postJson<WorkGenerateResponse>({
      action: 'work_generate',
      hash,
      ...(difficulty ? { difficulty } : {}),
    });
  }

  getAuditReport(): EndpointAuditRecord[] {
    return this.pool.getAuditReport();
  }
}

export function createRpcPool(nodes: RpcNodeConfig[]): RpcPool {
  const stateListeners = new Set<(state: RpcPoolState) => void>();
  let currentState: RpcPoolState = { status: 'disconnected' };
  const rpcPool = new HttpEndpointPool({
    kind: 'rpc',
    urls: nodes.map((node) => node.rpc),
    defaults: nodes.map((node) => node.rpc),
    onActiveEndpointChange(event: EndpointActivityEvent) {
      if (event.kind !== 'rpc') return;

      const activeNode = nodeFromRpcUrl(nodes, event.activeUrl);
      const previousNode = event.previousUrl ? nodeFromRpcUrl(nodes, event.previousUrl) : undefined;
      currentState = {
        status: event.status,
        ...(activeNode ? { activeNode } : {}),
        ...(previousNode ? { previousNode } : {}),
      };
      for (const listener of stateListeners) listener(currentState);
    },
  });

  function sortedNodes(): RpcNodeConfig[] {
    return [...nodes].sort((a, b) => b.priority - a.priority);
  }

  function buildClient(): RpcClient {
    return new PooledRpcClient(rpcPool);
  }

  return {
    getClient(): RpcClient {
      return buildClient();
    },

    addNode(config: RpcNodeConfig): void {
      const existing = nodes.findIndex((n) => n.rpc === config.rpc);
      if (existing >= 0) nodes[existing] = config;
      else nodes.push(config);
    },

    removeNode(rpcUrl: string): void {
      const idx = nodes.findIndex((n) => n.rpc === rpcUrl);
      if (idx < 0) return;
      nodes.splice(idx, 1);
    },

    getActiveNode(): RpcClient | undefined {
      if (!currentState.activeNode && nodes.length === 0) return undefined;
      return buildClient();
    },

    onStateChange(listener: (state: RpcPoolState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    getAuditReport(): EndpointAuditRecord[] {
      return rpcPool.getAuditReport();
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

export function createWsClient(wsUrl: string): WsClient {
  const pool = new WsEndpointPool({
    urls: [wsUrl],
    defaults: [wsUrl],
  });

  let ws: WebSocket | null = null;
  const accounts = new Set<string>();
  const confirmationListeners = new Set<(block: ConfirmedBlock) => void>();

  async function establish(): Promise<void> {
    ws = await pool.connect();
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
      return pool.getAuditReport();
    },
  };
}
