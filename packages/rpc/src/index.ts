// @openrai/rpc — Multi-node RPC, WebSocket, failover, and confirmation tracking

import { NanoClient } from '@openrai/nano-core';
import type { EndpointAuditRecord } from '@openrai/nano-core/transport';
import type { ConfirmedBlock } from '@openrai/model';

export interface RpcNodeConfig {
  rpc: string[];
  ws: string[];
  work: string[];
}

export interface RpcClient {
  accountInfo(account: string): Promise<AccountInfoResponse | undefined>;
  accountsReceivable(account: string): Promise<Receivable[]>;
  process(block: string): Promise<ProcessResponse>;
  workGenerate(hash: string, difficulty?: string, blockType?: 'send' | 'receive'): Promise<WorkGenerateResponse>;
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
  getActiveDifficulty(): Promise<ActiveDifficulty>;
  invalidateDifficultyCache(): void;
}

export interface ActiveDifficulty {
  send: string;
  receive: string;
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

function configuredWorkUrls(nodes: RpcNodeConfig[]): string[] {
  return nodes.flatMap((node) => node.work);
}

class PooledRpcClient implements RpcClient {
  constructor(
    private readonly client: NanoClient,
    private readonly getDifficulty: () => Promise<ActiveDifficulty>,
  ) {}

  async accountInfo(account: string): Promise<AccountInfoResponse | undefined> {
    try {
      return await this.client.rpcPool.postJson<AccountInfoResponse>({
        action: 'account_info',
        account,
        representative: true,
        confirmed: true,
      });
    } catch (err) {
      // Nano nodes return "Account not found" for unopened accounts.
      // This is not an error — it simply means the account has not been opened yet.
      if (err instanceof Error && err.message === 'Account not found') {
        return undefined;
      }
      throw err;
    }
  }

  async accountsReceivable(account: string): Promise<Receivable[]> {
    let response: { blocks?: Record<string, { amount: string; sender: string }> };
    try {
      response = await this.client.rpcPool.postJson<{ blocks: Record<string, { amount: string; sender: string }> }>({
        action: 'accounts_receivable',
        accounts: [account],
        source: true,
        include_only_confirmed: false,
      });
    } catch (err) {
      // Nano nodes return "Account not found" for unopened accounts.
      // This is not an error — it simply means there are zero receivable blocks.
      if (err instanceof Error && err.message === 'Account not found') {
        return [];
      }
      throw err;
    }

    if (!response.blocks) return [];

    return Object.entries(response.blocks).map(([hash, block]) => ({
      hash,
      amount: block.amount,
      sender: block.sender,
    }));
  }

  async process(block: string): Promise<ProcessResponse> {
    return this.client.rpcPool.postJson<ProcessResponse>({ action: 'process', block });
  }

  async workGenerate(hash: string, difficulty?: string, blockType?: 'send' | 'receive'): Promise<WorkGenerateResponse> {
    let effectiveDifficulty: string;
    if (difficulty) {
      effectiveDifficulty = difficulty;
    } else {
      const active = await this.getDifficulty();
      effectiveDifficulty = blockType === 'receive' ? active.receive : active.send;
    }
    return {
      work: await this.client.workProvider.generate(hash, effectiveDifficulty),
    };
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

  const DIFFICULTY_CACHE_TTL_MS = 60_000;
  let difficultyCache: { send: string; receive: string; fetchedAt: number } | null = null;

  async function getActiveDifficulty(): Promise<ActiveDifficulty> {
    const now = Date.now();
    if (difficultyCache && now - difficultyCache.fetchedAt < DIFFICULTY_CACHE_TTL_MS) {
      return { send: difficultyCache.send, receive: difficultyCache.receive };
    }
    const raw = await client.rpcPool.postJson<{
      network_minimum: string;
      network_receive_minimum: string;
      network_current: string;
      network_receive_current: string;
    }>({ action: 'active_difficulty' });

    difficultyCache = { send: raw.network_current, receive: raw.network_receive_current, fetchedAt: now };
    return { send: raw.network_current, receive: raw.network_receive_current };
  }

  function invalidateDifficultyCache(): void {
    difficultyCache = null;
  }

  function buildClientOptions(configuredNodes: RpcNodeConfig[]) {
    const rpc = configuredRpcUrls(configuredNodes);
    const ws = configuredWsUrls(configuredNodes);
    const work = configuredWorkUrls(configuredNodes);
    return {
      ...(rpc.length > 0 ? { rpc } : {}),
      ...(ws.length > 0 ? { ws } : {}),
      ...(work.length > 0 ? { work } : {}),
    };
  }

  function refreshClient(): void {
    detachEndpointListener();
    client = NanoClient.initialize(buildClientOptions(nodes));
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
    return new PooledRpcClient(client, getActiveDifficulty);
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

    getActiveDifficulty,
    invalidateDifficultyCache,
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
