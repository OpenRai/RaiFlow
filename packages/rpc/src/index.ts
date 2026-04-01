// @openrai/rpc — Multi-node RPC, WebSocket, failover, and confirmation tracking

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
}

export interface RpcPoolState {
  status: 'connected' | 'disconnected' | 'failover';
  activeNode?: RpcNodeConfig;
  previousNode?: RpcNodeConfig;
}

async function jsonRpc<T>(url: string, method: string, params?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: method, ...params }),
  });
  if (!response.ok) {
    throw new Error(`RPC error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as { error?: string } & T;
  if (data.error) {
    throw new Error(`RPC error: ${data.error}`);
  }
  return data;
}

class SingleNodeClient implements RpcClient {
  constructor(private readonly url: string) {}

  async accountInfo(account: string): Promise<AccountInfoResponse> {
    return jsonRpc(this.url, 'account_info', { account, representative: true, confirmed: true }) as Promise<AccountInfoResponse>;
  }

  async accountsReceivable(account: string): Promise<Receivable[]> {
    const response = await jsonRpc<{ blocks: Record<string, { amount: string; sender: string }> }>(
      this.url,
      'accounts_receivable',
      { account, source: true, include_only_confirmed: false },
    );
    return Object.entries(response.blocks).map(([hash, block]) => ({
      hash,
      amount: block.amount,
      sender: block.sender,
    }));
  }

  async process(block: string): Promise<ProcessResponse> {
    return jsonRpc(this.url, 'process', { block }) as Promise<ProcessResponse>;
  }

  async workGenerate(hash: string, difficulty?: string): Promise<WorkGenerateResponse> {
    const params: Record<string, unknown> = { hash };
    if (difficulty) params['difficulty'] = difficulty;
    return jsonRpc(this.url, 'work_generate', params) as Promise<WorkGenerateResponse>;
  }
}

export function createRpcPool(nodes: RpcNodeConfig[]): RpcPool {
  const stateListeners = new Set<(state: RpcPoolState) => void>();
  let activeIndex = -1;
  let currentState: RpcPoolState = { status: 'disconnected' };

  function sortByPriority(): number {
    return [...nodes].sort((a, b) => b.priority - a.priority).findIndex((n) => n.rpc === nodes[activeIndex]?.rpc);
  }

  function setActive(index: number, prev?: RpcNodeConfig): void {
    activeIndex = index;
    currentState = {
      status: index >= 0 ? 'connected' : 'disconnected',
      activeNode: nodes[index],
      previousNode: prev,
    };
    for (const listener of stateListeners) {
      listener(currentState);
    }
  }

  function init(): void {
    const sorted = [...nodes].sort((a, b) => b.priority - a.priority);
    const first = sorted[0];
    if (first !== undefined) {
      const idx = nodes.indexOf(first);
      setActive(idx);
    }
  }

  init();

  async function healthCheck(url: string): Promise<boolean> {
    try {
      await jsonRpc<{ nickname?: string }>(url, 'version');
      return true;
    } catch {
      return false;
    }
  }

  return {
    getClient(): RpcClient {
      const node = nodes[activeIndex];
      if (!node) throw new Error('No active RPC node available');
      return new SingleNodeClient(node.rpc);
    },

    addNode(config: RpcNodeConfig): void {
      const existing = nodes.findIndex((n) => n.rpc === config.rpc);
      if (existing >= 0) {
        nodes[existing] = config;
      } else {
        nodes.push(config);
      }
      if (activeIndex < 0) {
        const sorted = [...nodes].sort((a, b) => b.priority - a.priority);
        const first = sorted[0];
        if (first !== undefined) setActive(nodes.indexOf(first));
      }
    },

    removeNode(rpcUrl: string): void {
      const idx = nodes.findIndex((n) => n.rpc === rpcUrl);
      if (idx < 0) return;
      const prev = nodes[activeIndex];
      nodes.splice(idx, 1);
      if (idx === activeIndex) {
        if (nodes.length === 0) {
          setActive(-1, prev);
        } else {
          const sorted = [...nodes].sort((a, b) => b.priority - a.priority);
          const first = sorted[0];
          setActive(first !== undefined ? nodes.indexOf(first) : -1, prev);
        }
      }
    },

    getActiveNode(): RpcClient | undefined {
      const node = nodes[activeIndex];
      return node ? new SingleNodeClient(node.rpc) : undefined;
    },

    onStateChange(listener: (state: RpcPoolState) => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}

export interface WsClient {
  connect(accounts: string[]): void;
  disconnect(): void;
  addAccount(account: string): void;
  removeAccount(account: string): void;
  onConfirmation(listener: (block: ConfirmedBlock) => void): () => void;
}

export function createWsClient(wsUrl: string): WsClient {
  let ws: WebSocket | null = null;
  const accounts = new Set<string>();
  const confirmationListeners = new Set<(block: ConfirmedBlock) => void>();
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function connect(): void {
    if (ws) {
      ws.close();
    }
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      if (accounts.size > 0) {
        const msg = {
          action: 'subscribe',
          topic: 'confirmation',
          options: {
            accounts: [...accounts],
            include_block: true,
          },
        };
        ws!.send(JSON.stringify(msg));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        if (msg.topic === 'confirmation' && msg.message) {
          const m = msg.message as Record<string, unknown>;
          const block = m.block as Record<string, unknown> | undefined;
          if (block) {
            const confirmedBlock: ConfirmedBlock = {
              blockHash: block.hash as string,
              senderAccount: (block.account as string) ?? '',
              recipientAccount: (block.contents as string) ?? '',
              amountRaw: m.amount as string,
              confirmedAt: new Date().toISOString(),
            };
            for (const listener of confirmationListeners) {
              listener(confirmedBlock);
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      ws = null;
      reconnectTimer = setTimeout(connect, 5000);
    };
  }

  return {
    connect(accounts_: string[]): void {
      for (const a of accounts_) accounts.add(a);
      connect();
    },

    disconnect(): void {
      if (reconnectTimer) clearTimeout(reconnectTimer);
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
  };
}
