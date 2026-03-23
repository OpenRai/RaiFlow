/**
 * @openrai/watcher — src/rpc.ts
 *
 * Minimal typed Nano RPC client using Node's built-in fetch.
 * Requires Node 18+ (fetch is available globally).
 *
 * No external dependencies.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NanoRpcConfig {
  url: string;
  /** Request timeout in milliseconds. Default: 15000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class NanoRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NanoRpcError';
  }
}

// ---------------------------------------------------------------------------
// Response shapes (raw RPC)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

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
  /** The link_as_account field (recipient for send blocks). */
  linkAsAccount?: string;
  amount: string;
  hash: string;
  confirmed: boolean;
  localTimestamp?: string;
}

// ---------------------------------------------------------------------------

interface RpcAccountsReceivableResponse {
  blocks: Record<string, string[]>;
  error?: string;
}

export type AccountsReceivable = Record<string, string[]>;

// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NanoRpcClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(config: NanoRpcConfig) {
    this.url = config.url;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort =
        err instanceof Error && err.name === 'AbortError';
      throw new NanoRpcError(
        isAbort ? `RPC request timed out after ${this.timeoutMs}ms` : `RPC fetch failed: ${String(err)}`,
        isAbort ? 'TIMEOUT' : 'FETCH_ERROR',
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new NanoRpcError(
        `RPC HTTP error ${response.status}: ${response.statusText}`,
        `HTTP_${response.status}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new NanoRpcError('Failed to parse RPC response as JSON', 'PARSE_ERROR', err);
    }

    return json as T;
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  /**
   * Fetch account info (frontier, balance, representative, block count).
   * Returns `undefined` if the account is not found / unopened.
   */
  async accountInfo(account: string): Promise<AccountInfo | undefined> {
    const raw = await this.post<RpcAccountInfoResponse>({
      action: 'account_info',
      account,
    });

    if (raw.error === 'Account not found') {
      return undefined;
    }
    if (raw.error) {
      throw new NanoRpcError(`account_info error: ${raw.error}`, 'RPC_ERROR');
    }

    return {
      frontier: raw.frontier,
      balance: raw.balance,
      representative: raw.representative,
      blockCount: raw.block_count,
    };
  }

  /**
   * Fetch recent confirmed blocks for an account.
   */
  async accountHistory(account: string, count: number): Promise<HistoryBlock[]> {
    const raw = await this.post<RpcAccountHistoryResponse>({
      action: 'account_history',
      account,
      count: String(count),
      raw: true,
    });

    if (raw.error) {
      throw new NanoRpcError(`account_history error: ${raw.error}`, 'RPC_ERROR');
    }

    const history = raw.history ?? [];
    return history.map((b) => ({
      type: b.type,
      subtype: b.subtype,
      account: b.account,
      linkAsAccount: b.link_as_account,
      amount: b.amount,
      hash: b.hash,
      confirmed: b.confirmed === 'true' || b.confirmed === '1',
      localTimestamp: b.local_timestamp,
    }));
  }

  /**
   * Fetch pending (receivable) block hashes for a list of accounts.
   */
  async accountsReceivable(accounts: string[], count: number): Promise<AccountsReceivable> {
    const raw = await this.post<RpcAccountsReceivableResponse>({
      action: 'accounts_receivable',
      accounts,
      count: String(count),
      threshold: '1',
    });

    if (raw.error) {
      throw new NanoRpcError(`accounts_receivable error: ${raw.error}`, 'RPC_ERROR');
    }

    return raw.blocks ?? {};
  }

  /**
   * Fetch detailed info about a specific block.
   */
  async blockInfo(hash: string): Promise<BlockInfo> {
    const raw = await this.post<RpcBlockInfoResponse>({
      action: 'block_info',
      json_block: 'true',
      hash,
    });

    if (raw.error) {
      throw new NanoRpcError(`block_info error: ${raw.error}`, 'RPC_ERROR');
    }

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
