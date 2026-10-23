import { describe, expect, it, vi } from 'vitest';
import { AccountHistoryRecovery, createInMemoryRecoveryCursorStore } from '../recovery.js';
import type { NanoRpcClient } from '../rpc.js';
import type { ConfirmedBlock, WatcherSink } from '@openrai/model';

const recipient = 'nano_recipient';

function history(hash: string, link: string, subtype = 'receive') {
  return { type: 'state', subtype, account: recipient, amount: '10', hash, link, confirmed: true };
}

function sourceInfo(hash: string) {
  return {
    blockAccount: `nano_sender_${hash}`,
    amount: '10',
    confirmed: true,
    subtype: 'send',
    localTimestamp: '1792630860',
    contents: { type: 'state', account: '', linkAsAccount: recipient },
  };
}

describe('AccountHistoryRecovery', () => {
  it('reconciles a bounded initial history window from oldest to newest', async () => {
    const rpc = {
      accountHistory: vi.fn().mockResolvedValue([
        history('account-head-3', 'source-3'),
        history('account-head-2', 'source-2'),
        history('account-head-1', 'source-1', 'open'),
      ]),
      blockInfo: vi.fn(async (hash: string) => sourceInfo(hash)),
    } as unknown as NanoRpcClient;
    const handleConfirmedBlock = vi.fn().mockResolvedValue(undefined);
    const sink = { handleConfirmedBlock } as unknown as WatcherSink;
    const cursors = createInMemoryRecoveryCursorStore();
    const recovery = new AccountHistoryRecovery(rpc, sink, cursors, 3);

    await recovery.reconcile(recipient);

    expect(handleConfirmedBlock.mock.calls.map(([block]) => (block as ConfirmedBlock).blockHash))
      .toEqual(['source-1', 'source-2', 'source-3']);
    expect(await cursors.get(recipient)).toBe('account-head-3');
  });

  it('does not advance the cursor when the shared ingest sink fails, then retries', async () => {
    const cursors = createInMemoryRecoveryCursorStore();
    await cursors.set(recipient, 'account-head-1');
    const rpc = {
      accountHistory: vi.fn().mockResolvedValue([
        history('account-head-1', 'source-1'),
        history('account-head-2', 'source-2'),
      ]),
      blockInfo: vi.fn(async (hash: string) => sourceInfo(hash)),
    } as unknown as NanoRpcClient;
    const handleConfirmedBlock = vi.fn()
      .mockRejectedValueOnce(new Error('ingest failed'))
      .mockResolvedValue(undefined);
    const recovery = new AccountHistoryRecovery(rpc, { handleConfirmedBlock } as unknown as WatcherSink, cursors, 2);

    await expect(recovery.reconcile(recipient)).rejects.toThrow('ingest failed');
    expect(await cursors.get(recipient)).toBe('account-head-1');
    await recovery.reconcile(recipient);

    expect(rpc.accountHistory).toHaveBeenNthCalledWith(1, recipient, 2, { head: 'account-head-1', reverse: true });
    expect(await cursors.get(recipient)).toBe('account-head-2');
    expect(handleConfirmedBlock).toHaveBeenCalledTimes(2);
  });

  it('does not advance past a receive before its source send is confirmed', async () => {
    const cursors = createInMemoryRecoveryCursorStore();
    await cursors.set(recipient, 'account-head-1');
    const rpc = {
      accountHistory: vi.fn().mockResolvedValue([history('account-head-2', 'source-2')]),
      blockInfo: vi.fn().mockResolvedValue({ ...sourceInfo('source-2'), confirmed: false }),
    } as unknown as NanoRpcClient;
    const sink = { handleConfirmedBlock: vi.fn() } as unknown as WatcherSink;
    const recovery = new AccountHistoryRecovery(rpc, sink, cursors, 10);

    await recovery.reconcile(recipient);

    expect(await cursors.get(recipient)).toBe('account-head-1');
    expect(sink.handleConfirmedBlock).not.toHaveBeenCalled();
  });
});
