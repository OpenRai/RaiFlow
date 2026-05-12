// @openrai/runtime — AccountStateSync tests

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AccountStore, AccountEvent, ConfirmedBlock } from '@openrai/model';
import { AccountStateSync } from '../account-state-sync.js';

const TEST_ADDRESS = 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';

function createMockAccountStore(): AccountStore {
  return {
    create: vi.fn(),
    get: vi.fn(),
    getByAddress: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
  };
}

function createMockRpcPool() {
  return {
    getClient: vi.fn().mockReturnValue({
      accountInfo: vi.fn(),
    }),
    getActiveDifficulty: vi.fn(),
    invalidateDifficultyCache: vi.fn(),
    addNode: vi.fn(),
    removeNode: vi.fn(),
    getActiveNode: vi.fn(),
    onStateChange: vi.fn(),
    getAuditReport: vi.fn(),
  };
}

function makeAccount(overrides?: Partial<Parameters<AccountStore['update']>[1] & { id: string; address: string }>) {
  return {
    id: 'acc-1',
    type: 'watched' as const,
    address: TEST_ADDRESS,
    label: null,
    balanceRaw: '0',
    pendingRaw: '0',
    frontier: null,
    representative: null,
    derivationIndex: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('AccountStateSync', () => {
  let accountStore: ReturnType<typeof createMockAccountStore>;
  let rpcPool: ReturnType<typeof createMockRpcPool>;
  let watcher: { addAccount: ReturnType<typeof vi.fn>; removeAccount: ReturnType<typeof vi.fn> };
  let events: AccountEvent[];
  let forwardedBlocks: ConfirmedBlock[];
  let sync: AccountStateSync;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    accountStore = createMockAccountStore();
    rpcPool = createMockRpcPool();
    watcher = {
      addAccount: vi.fn(),
      removeAccount: vi.fn(),
    };
    events = [];
    forwardedBlocks = [];

    sync = new AccountStateSync(
      rpcPool as any,
      accountStore,
      watcher,
      (event) => events.push(event),
      (block) => { forwardedBlocks.push(block); return Promise.resolve(); },
      { reconcileIntervalMs: 30_000, initialSyncDelayMs: 0 },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    sync.stop();
  });

  it('addAccount performs initial sync and emits state_synced', async () => {
    const account = makeAccount();
    (accountStore.getByAddress as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...account, balanceRaw: '1000', frontier: 'hash1' });
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue({
      accountInfo: vi.fn().mockResolvedValue({
        frontier: 'hash1',
        balance: '1000',
        representative: 'nano_1rep',
        blockCount: 5,
      }),
    });

    await sync.addAccount(TEST_ADDRESS);

    expect(watcher.addAccount).toHaveBeenCalledWith(TEST_ADDRESS);
    expect(accountStore.update).toHaveBeenCalledWith('acc-1', {
      balanceRaw: '1000',
      frontier: 'hash1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('account.state_synced');
    expect(events[0]!.data.snapshot).toEqual({
      balanceRaw: '1000',
      frontier: 'hash1',
      representative: null,
      blockCount: 5,
    });
  });

  it('addAccount emits state_synced even when no drift', async () => {
    const account = makeAccount();
    (accountStore.getByAddress as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue({
      accountInfo: vi.fn().mockResolvedValue(null), // unopened
    });

    await sync.addAccount(TEST_ADDRESS);

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('account.state_synced');
    expect(events[0]!.data.snapshot!.balanceRaw).toBe('0');
  });

  it('handleConfirmedBlock updates balance and frontier', async () => {
    const account = makeAccount({ balanceRaw: '1000', frontier: 'hash1' });
    (accountStore.getByAddress as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...account, balanceRaw: '2000', frontier: 'hash2' });

    await sync.addAccount(TEST_ADDRESS);

    const block: ConfirmedBlock = {
      blockHash: 'hash2',
      senderAccount: 'nano_sender',
      recipientAccount: TEST_ADDRESS,
      amountRaw: '1000',
      confirmedAt: new Date().toISOString(),
    };

    await sync.handleConfirmedBlock(block);

    expect(accountStore.update).toHaveBeenCalledWith('acc-1', {
      balanceRaw: '2000',
      frontier: 'hash2',
    });
    expect(events.some((e) => e.type === 'account.payment_received')).toBe(true);
    expect(forwardedBlocks).toContainEqual(block);
  });

  it('periodic reconciliation emits balance_updated on drift', async () => {
    const account = makeAccount({ balanceRaw: '1000', frontier: 'hash1' });
    (accountStore.getByAddress as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...account, balanceRaw: '5000' });
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue({
      accountInfo: vi.fn().mockResolvedValue({
        frontier: 'hash1',
        balance: '5000',
        representative: 'nano_1rep',
        blockCount: 10,
      }),
    });

    await sync.addAccount(TEST_ADDRESS);
    events.length = 0;

    sync.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(accountStore.update).toHaveBeenCalledWith('acc-1', { balanceRaw: '5000' });
    expect(events.some((e) => e.type === 'account.balance_updated')).toBe(true);
  });

  it('removeAccount removes from watcher', () => {
    sync.removeAccount(TEST_ADDRESS);
    expect(watcher.removeAccount).toHaveBeenCalledWith(TEST_ADDRESS);
  });

  it('addAccount survives RPC failure and emits state_synced with local state', async () => {
    const account = makeAccount();
    (accountStore.getByAddress as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue({
      accountInfo: vi.fn().mockRejectedValue(new Error('All endpoints exhausted')),
    });

    await sync.addAccount(TEST_ADDRESS);

    expect(watcher.addAccount).toHaveBeenCalledWith(TEST_ADDRESS);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('account.state_synced');
    expect(events[0]!.data.snapshot).toEqual({
      balanceRaw: '0',
      frontier: null,
      representative: null,
      blockCount: 0,
    });
  });

  it('addAccount does not block subsequent accounts when one fails', async () => {
    const accountA = makeAccount({ id: 'acc-a', address: 'nano_1a' });
    const accountB = makeAccount({ id: 'acc-b', address: 'nano_1b' });

    (accountStore.getByAddress as ReturnType<typeof vi.fn>).mockImplementation((addr: string) =>
      addr === 'nano_1a' ? Promise.resolve(accountA) : Promise.resolve(accountB),
    );
    (accountStore.get as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'acc-a' ? Promise.resolve(accountA) : Promise.resolve(accountB),
    );

    const accountInfo = vi.fn();
    accountInfo.mockImplementation((addr: string) => {
      if (addr === 'nano_1a') return Promise.reject(new Error('boom'));
      return Promise.resolve({ frontier: 'hash-b', balance: '1000', representative: 'nano_1rep', blockCount: 3 });
    });
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue({ accountInfo });
    (accountStore.update as ReturnType<typeof vi.fn>).mockImplementation((id: string, updates: any) =>
      Promise.resolve(id === 'acc-a' ? { ...accountA, ...updates } : { ...accountB, ...updates }),
    );

    await sync.addAccount('nano_1a');
    await sync.addAccount('nano_1b');

    expect(watcher.addAccount).toHaveBeenCalledWith('nano_1a');
    expect(watcher.addAccount).toHaveBeenCalledWith('nano_1b');
    expect(events).toHaveLength(2);
    expect(events.some((e) => e.accountAddress === 'nano_1b' && e.data.snapshot!.balanceRaw === '1000')).toBe(true);
  });
});
