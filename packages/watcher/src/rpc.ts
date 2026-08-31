import { NanoClient } from '@openrai/nano-core';
import type { EndpointAuditRecord } from '@openrai/nano-core/transport';

export interface NanoRpcConfig {
  url?: string;
  /** Request timeout in milliseconds. Default: 15000 */
  timeoutMs?: number;
}

export class NanoRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NanoRpcError';
  }
}

interface RpcAccountInfoResponse {
  frontier: string;
  balance: string;
  representative: string;
  block_count: string;
  error?: string;
}

export interface AccountInfo {
  frontier: string;
  balance: string;
  representative: string;
  blockCount: string;
}

interface RpcHistoryBlock {
  type: string;
  account: string;
  amount: string;
  hash: string;
  confirmed: string;
  subtype?: string;
  local_timestamp?: string;
  link_as_account?: string;
}

interface RpcAccountHistoryResponse {
  account: string;
  history: RpcHistoryBlock[];
  error?: string;
}

export interface HistoryBlock {
  type: string;
  subtype?: string;
  account: string;
  linkAsAccount?: string;
  amount: string;
  hash: string;
  confirmed: boolean;
  localTimestamp?: string;
}

interface RpcAccountsReceivableResponse {
  blocks: Record<string, string[]>;
  error?: string;
}

interface RpcPendingResponse {
  blocks?: Record<string, { amount: string; source?: string; sender?: string }>;
  error?: string;
}

export type AccountsReceivable = Record<string, string[]>;

interface RpcBlockInfoResponse {
  block_account: string;
  amount: string;
  balance: string;
  height: string;
  local_timestamp: string;
  successor: string;
  confirmed: string;
  contents: {
    type: string;
    account: string;
    representative: string;
    balance: string;
    link: string;
    link_as_account: string;
    signature: string;
    work: string;
    subtype?: string;
  };
  subtype: string;
  error?: string;
}

export interface BlockInfo {
  blockAccount: string;
  amount: string;
  confirmed: boolean;
  subtype: string;
  localTimestamp: string;
  contents: {
    type: string;
    account: string;
    linkAsAccount: string;
    subtype?: string;
  };
}

export class NanoRpcClient {
  private readonly client: NanoClient;
  private readonly timeoutMs: number;

  constructor(config: NanoRpcConfig) {
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.client = NanoClient.initialize({
      ...(config.url ? { rpc: [config.url] } : {}),
    });
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    try {
      return await this.client.rpcPool.postJson<T>(body);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const message = isAbort
        ? `RPC request timed out after ${this.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);

      throw new NanoRpcError(
        isAbort ? message : `RPC request failed: ${message}`,
        isAbort ? 'TIMEOUT' : 'RPC_ERROR',
        err,
      );
    }
  }

  getAuditReport(): EndpointAuditRecord[] {
    return this.client.rpcPool.getAuditReport();
  }

  async accountInfo(account: string): Promise<AccountInfo | undefined> {
    const raw = await this.post<RpcAccountInfoResponse>({
      action: 'account_info',
      account,
    });

    if (raw.error === 'Account not found') return undefined;
    if (raw.error) throw new NanoRpcError(`account_info error: ${raw.error}`, 'RPC_ERROR');

    return {
      frontier: raw.frontier,
      balance: raw.balance,
      representative: raw.representative,
      blockCount: raw.block_count,
    };
  }

  async accountHistory(account: string, count: number): Promise<HistoryBlock[]> {
    const raw = await this.post<RpcAccountHistoryResponse>({
      action: 'account_history',
      account,
      count: String(count),
      raw: true,
    });

    if (raw.error) throw new NanoRpcError(`account_history error: ${raw.error}`, 'RPC_ERROR');

    return (raw.history ?? []).map((block) => ({
      type: block.type,
      subtype: block.subtype,
      account: block.account,
      linkAsAccount: block.link_as_account,
      amount: block.amount,
      hash: block.hash,
      confirmed: block.confirmed === 'true' || block.confirmed === '1',
      localTimestamp: block.local_timestamp,
    }));
  }

  async accountsReceivable(accounts: string[], count: number): Promise<AccountsReceivable> {
    let raw: RpcAccountsReceivableResponse;
    try {
      raw = await this.post<RpcAccountsReceivableResponse>({
        action: 'accounts_receivable',
        accounts,
        count: String(count),
        threshold: '1',
      });
    } catch (error) {
      // Some hosted nodes return HTTP 500 for the disabled
      // accounts_receivable action. Retry the equivalent pending query while
      // keeping provider-specific behavior behind RaiFlow's watcher boundary.
      const message = error instanceof Error ? error.message : String(error);
      if (!/HTTP error 500|accounts_receivable.*not allowed/i.test(message)) throw error;
      const pending = await Promise.all(accounts.map(async (account) => {
        const result = await this.post<RpcPendingResponse>({
          action: 'pending',
          account,
          count: String(count),
          threshold: '1',
          source: true,
        });
        if (result.error === 'Account not found') return [account, []] as const;
        if (result.error) throw new NanoRpcError(`pending error: ${result.error}`, 'RPC_ERROR');
        return [account, Object.keys(result.blocks ?? {})] as const;
      }));
      return Object.fromEntries(pending);
    }

    if (raw.error) throw new NanoRpcError(`accounts_receivable error: ${raw.error}`, 'RPC_ERROR');

    return raw.blocks ?? {};
  }

  async blockInfo(hash: string): Promise<BlockInfo> {
    const raw = await this.post<RpcBlockInfoResponse>({
      action: 'block_info',
      json_block: 'true',
      hash,
    });

    if (raw.error) throw new NanoRpcError(`block_info error: ${raw.error}`, 'RPC_ERROR');

    return {
      blockAccount: raw.block_account,
      amount: raw.amount,
      confirmed: raw.confirmed === 'true' || raw.confirmed === '1',
      subtype: raw.subtype,
      localTimestamp: raw.local_timestamp,
      contents: {
        type: raw.contents.type,
        account: raw.contents.account,
        linkAsAccount: raw.contents.link_as_account,
        subtype: raw.contents.subtype,
      },
    };
  }
}
