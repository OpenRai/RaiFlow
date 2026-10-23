// @openrai/runtime — AccountStateSync tests
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountStateSync } from '../account-state-sync.js';
const TEST_ADDRESS = 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';
function createMockAccountStore() {
    return {
        create: vi.fn(),
        get: vi.fn(),
        getByAddress: vi.fn(),
        list: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    };
}
function createMockRpcPool() {
    return {
        getClient: vi.fn().mockReturnValue({
            accountInfo: vi.fn(),
        }),
        addNode: vi.fn(),
        removeNode: vi.fn(),
        getActiveNode: vi.fn(),
        onStateChange: vi.fn(),
        getAuditReport: vi.fn(),
    };
}
function makeAccount(overrides) {
    return {
        id: 'acc-1',
        accountKey: null,
        type: 'watched',
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
    let accountStore;
    let rpcPool;
    let watcher;
    let events;
    let forwardedBlocks;
    let sync;
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
        sync = new AccountStateSync(rpcPool, accountStore, watcher, (event) => events.push(event), (block) => { forwardedBlocks.push(block); return Promise.resolve(); }, { reconcileIntervalMs: 30_000, initialSyncDelayMs: 0 });
    });
    afterEach(() => {
        vi.useRealTimers();
        sync.stop();
    });
    it('addAccount performs initial sync and emits state_synced', async () => {
        const account = makeAccount();
        accountStore.getByAddress.mockResolvedValue(account);
        accountStore.get.mockResolvedValue(account);
        accountStore.update.mockResolvedValue({ ...account, balanceRaw: '1000', frontier: 'hash1' });
        rpcPool.getClient.mockReturnValue({
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
        expect(events[0].type).toBe('account.state_synced');
        expect(events[0].data.snapshot).toEqual({
            balanceRaw: '1000',
            frontier: 'hash1',
            representative: null,
            blockCount: 5,
        });
    });
    it('addAccount emits state_synced even when no drift', async () => {
        const account = makeAccount();
        accountStore.getByAddress.mockResolvedValue(account);
        accountStore.get.mockResolvedValue(account);
        rpcPool.getClient.mockReturnValue({
            accountInfo: vi.fn().mockResolvedValue(null), // unopened
        });
        await sync.addAccount(TEST_ADDRESS);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('account.state_synced');
        expect(events[0].data.snapshot.balanceRaw).toBe('0');
    });
    it('clears stale state when a watched account is still unopened', async () => {
        const account = makeAccount({ balanceRaw: '20000000000000000000000000', frontier: 'stale-send-hash' });
        accountStore.getByAddress.mockResolvedValue(account);
        accountStore.get.mockResolvedValue(account);
        rpcPool.getClient.mockReturnValue({
            accountInfo: vi.fn().mockResolvedValue(null),
        });
        await sync.addAccount(TEST_ADDRESS);
        expect(accountStore.update).toHaveBeenCalledWith('acc-1', { balanceRaw: '0', frontier: null });
    });
    it('handleConfirmedBlock forwards the send without changing recipient chain state', async () => {
        const account = makeAccount({ balanceRaw: '1000', frontier: 'hash1' });
        accountStore.getByAddress.mockResolvedValue(account);
        accountStore.get.mockResolvedValue(account);
        rpcPool.getClient.mockReturnValue({
            accountInfo: vi.fn().mockResolvedValue({
                frontier: 'hash1',
                balance: '1000',
                representative: 'nano_1rep',
                blockCount: 5,
            }),
        });
        await sync.addAccount(TEST_ADDRESS);
        accountStore.update.mockClear();
        events.length = 0;
        const block = {
            blockHash: 'hash2',
            senderAccount: 'nano_sender',
            recipientAccount: TEST_ADDRESS,
            amountRaw: '1000',
            confirmedAt: new Date().toISOString(),
        };
        await sync.handleConfirmedBlock(block);
        expect(accountStore.update).not.toHaveBeenCalled();
        expect(events.some((e) => e.type === 'account.payment_received')).toBe(false);
        expect(forwardedBlocks).toContainEqual(block);
    });
    it('periodic reconciliation emits balance_updated on drift', async () => {
        const account = makeAccount({ balanceRaw: '1000', frontier: 'hash1' });
        accountStore.getByAddress.mockResolvedValue(account);
        accountStore.get.mockResolvedValue(account);
        accountStore.update.mockResolvedValue({ ...account, balanceRaw: '5000' });
        rpcPool.getClient.mockReturnValue({
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
        accountStore.getByAddress.mockResolvedValue(account);
        accountStore.get.mockResolvedValue(account);
        rpcPool.getClient.mockReturnValue({
            accountInfo: vi.fn().mockRejectedValue(new Error('All endpoints exhausted')),
        });
        await sync.addAccount(TEST_ADDRESS);
        expect(watcher.addAccount).toHaveBeenCalledWith(TEST_ADDRESS);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('account.state_synced');
        expect(events[0].data.snapshot).toEqual({
            balanceRaw: '0',
            frontier: null,
            representative: null,
            blockCount: 0,
        });
    });
    it('addAccount does not block subsequent accounts when one fails', async () => {
        const accountA = makeAccount({ id: 'acc-a', address: 'nano_1a' });
        const accountB = makeAccount({ id: 'acc-b', address: 'nano_1b' });
        accountStore.getByAddress.mockImplementation((addr) => addr === 'nano_1a' ? Promise.resolve(accountA) : Promise.resolve(accountB));
        accountStore.get.mockImplementation((id) => id === 'acc-a' ? Promise.resolve(accountA) : Promise.resolve(accountB));
        const accountInfo = vi.fn();
        accountInfo.mockImplementation((addr) => {
            if (addr === 'nano_1a')
                return Promise.reject(new Error('boom'));
            return Promise.resolve({ frontier: 'hash-b', balance: '1000', representative: 'nano_1rep', blockCount: 3 });
        });
        rpcPool.getClient.mockReturnValue({ accountInfo });
        accountStore.update.mockImplementation((id, updates) => Promise.resolve(id === 'acc-a' ? { ...accountA, ...updates } : { ...accountB, ...updates }));
        await sync.addAccount('nano_1a');
        await sync.addAccount('nano_1b');
        expect(watcher.addAccount).toHaveBeenCalledWith('nano_1a');
        expect(watcher.addAccount).toHaveBeenCalledWith('nano_1b');
        expect(events).toHaveLength(2);
        expect(events.some((e) => e.accountAddress === 'nano_1b' && e.data.snapshot.balanceRaw === '1000')).toBe(true);
    });
    it('restores existing accounts with bounded concurrency and exposes readiness', async () => {
        const addresses = ['nano_1a', 'nano_1b', 'nano_1c', 'nano_1d', 'nano_1e'];
        const accounts = new Map(addresses.map((address, index) => [address, makeAccount({ id: `acc-${index}`, address })]));
        accountStore.getByAddress.mockImplementation((address) => Promise.resolve(accounts.get(address)));
        accountStore.get.mockImplementation((id) => Promise.resolve([...accounts.values()].find((account) => account.id === id)));
        accountStore.update.mockImplementation(async (_id, patch) => ({
            ...makeAccount(),
            ...patch,
        }));
        let active = 0;
        let maxActive = 0;
        rpcPool.getClient.mockReturnValue({
            accountInfo: vi.fn().mockImplementation(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 10));
                active--;
                return { frontier: 'hash', balance: '1', representative: 'nano_1rep', blockCount: 1 };
            }),
        });
        const restore = sync.syncExistingAccounts(addresses, 2);
        expect(sync.isInitialSyncComplete()).toBe(false);
        await vi.advanceTimersByTimeAsync(30);
        await expect(restore).resolves.toEqual({ synced: 5, failed: 0 });
        expect(maxActive).toBeLessThanOrEqual(2);
        expect(sync.isInitialSyncComplete()).toBe(true);
    });
});
//# sourceMappingURL=account-state-sync.test.js.map