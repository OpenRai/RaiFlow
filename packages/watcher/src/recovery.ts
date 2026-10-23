import type { ConfirmedBlock, WatcherSink } from '@openrai/model';
import type { NanoRpcClient } from './rpc.js';

export interface RecoveryCursorStore {
  get(accountAddress: string): Promise<string | undefined>;
  set(accountAddress: string, blockHash: string): Promise<void>;
}

export function createInMemoryRecoveryCursorStore(): RecoveryCursorStore {
  const cursors = new Map<string, string>();
  return {
    async get(accountAddress) {
      return cursors.get(accountAddress);
    },
    async set(accountAddress, blockHash) {
      cursors.set(accountAddress, blockHash);
    },
  };
}

export class AccountHistoryRecovery {
  constructor(
    private readonly rpc: NanoRpcClient,
    private readonly sink: WatcherSink,
    private readonly cursors: RecoveryCursorStore,
    private readonly batchSize = 100,
  ) {}

  async reconcile(accountAddress: string): Promise<void> {
    const cursor = await this.cursors.get(accountAddress);
    let history = await this.rpc.accountHistory(
      accountAddress,
      this.batchSize,
      cursor ? { head: cursor, reverse: true } : undefined,
    );

    if (cursor) {
      const cursorPosition = history.findIndex((entry) => entry.hash === cursor);
      if (cursorPosition < 0) {
        // The previous cursor fell outside the provider's retained history.
        // Start a bounded recent scan rather than wedging recovery forever.
        history = await this.rpc.accountHistory(accountAddress, this.batchSize);
        history.reverse();
      } else {
        history = history.slice(cursorPosition + 1);
      }
    } else {
      // Default account_history order is newest first; process the bounded
      // initial window from oldest to newest so cursor progress is monotonic.
      history.reverse();
    }

    for (const entry of history) {
      if (isReceiveBlock(entry.type, entry.subtype)) {
        if (!entry.link) return;
        const source = await this.rpc.blockInfo(entry.link);
        // Do not advance past a receive until its source send is cemented and
        // still points at the account whose history is being reconciled.
        if (!source.confirmed) return;
        if (source.subtype === 'send' && source.contents.linkAsAccount === accountAddress) {
          const block: ConfirmedBlock = {
            blockHash: entry.link,
            senderAccount: source.blockAccount,
            recipientAccount: accountAddress,
            amountRaw: source.amount,
            confirmedAt: source.localTimestamp
              ? new Date(Number(source.localTimestamp) * 1000).toISOString()
              : new Date().toISOString(),
            alreadyReceived: true,
          };
          await this.sink.handleConfirmedBlock(block);
        }
      }
      await this.cursors.set(accountAddress, entry.hash);
    }
  }
}

function isReceiveBlock(type: string, subtype?: string): boolean {
  return subtype === 'receive' || subtype === 'open' || type === 'receive' || type === 'open';
}
