import { describe, it, expect, vi } from 'vitest';
import { Runtime, xnoToRaw } from '../runtime.js';
import { AccountStateSync } from '../account-state-sync.js';
import { ONE_XNO, HALF_XNO, TEST_ACCOUNT_2, createTestRuntime, createTestInvoice, makeBlock, } from './helpers.js';
describe('createInvoice', () => {
    it('registers each invoice pay address with the watcher', async () => {
        const watcher = { addAccount: vi.fn(), removeAccount: vi.fn() };
        const { runtime } = createTestRuntime({ watcher });
        const invoice = await runtime.createInvoice({ accountKey: 'acct-watch', expectedAmountRaw: ONE_XNO });
        expect(watcher.addAccount).toHaveBeenCalledWith(invoice.payAddress);
    });
    it('derives payAddress and defaults status/amount fields', async () => {
        const { runtime } = createTestRuntime();
        const invoice = await runtime.createInvoice({ accountKey: 'acct-1', expectedAmountRaw: ONE_XNO });
        expect(invoice.status).toBe('open');
        expect(invoice.receivedAmountRaw).toBe('0');
        expect(invoice.payAddress.startsWith('nano_') || invoice.payAddress.startsWith('xrb_')).toBe(true);
        expect(invoice.accountKey).toBe('acct-1');
    });
    it('is idempotent by key and returns the original invoice', async () => {
        const { runtime } = createTestRuntime();
        const inv1 = await runtime.createInvoice({ accountKey: 'acct-1', expectedAmountRaw: ONE_XNO }, 'inv-create-1');
        const inv2 = await runtime.createInvoice({ accountKey: 'acct-1', expectedAmountRaw: ONE_XNO }, 'inv-create-1');
        expect(inv1.id).toBe(inv2.id);
        expect(inv1.payAddress).toBe(inv2.payAddress);
    });
});
describe('createInvoice — accountKey required', () => {
    it('rejects with error when accountKey is missing/empty', async () => {
        const { runtime } = createTestRuntime();
        await expect(runtime.createInvoice({ expectedAmountRaw: ONE_XNO })).rejects.toThrow('accountKey is required');
        await expect(runtime.createInvoice({ accountKey: '', expectedAmountRaw: ONE_XNO })).rejects.toThrow('accountKey is required');
    });
    it('same accountKey + same invoiceKey → same payAddress across two separate createInvoice calls', async () => {
        const { runtime } = createTestRuntime();
        const inv1 = await runtime.createInvoice({
            accountKey: 'acct-stable',
            invoiceKey: 'inv-key-1',
            expectedAmountRaw: ONE_XNO,
        });
        const inv2 = await runtime.createInvoice({
            accountKey: 'acct-stable',
            invoiceKey: 'inv-key-1',
            expectedAmountRaw: HALF_XNO,
        });
        expect(inv1.id).not.toBe(inv2.id);
        expect(inv1.payAddress).toBe(inv2.payAddress);
    });
    it('same accountKey + different invoiceKey → different payAddress', async () => {
        const { runtime } = createTestRuntime();
        const inv1 = await runtime.createInvoice({
            accountKey: 'acct-scope',
            invoiceKey: 'inv-key-1',
            expectedAmountRaw: ONE_XNO,
        });
        const inv2 = await runtime.createInvoice({
            accountKey: 'acct-scope',
            invoiceKey: 'inv-key-2',
            expectedAmountRaw: ONE_XNO,
        });
        expect(inv1.payAddress).not.toBe(inv2.payAddress);
    });
});
describe('getInvoicesByAccountKey', () => {
    it('returns invoices matching accountKey', async () => {
        const { runtime } = createTestRuntime();
        const acctA1 = await runtime.createInvoice({ accountKey: 'acct-a', expectedAmountRaw: ONE_XNO });
        const acctA2 = await runtime.createInvoice({ accountKey: 'acct-a', expectedAmountRaw: HALF_XNO });
        await runtime.createInvoice({ accountKey: 'acct-b', expectedAmountRaw: ONE_XNO });
        const invoices = await runtime.getInvoicesByAccountKey('acct-a');
        const ids = invoices.map((invoice) => invoice.id);
        expect(ids).toContain(acctA1.id);
        expect(ids).toContain(acctA2.id);
        expect(invoices.every((invoice) => invoice.accountKey === 'acct-a')).toBe(true);
    });
    it('returns empty array for unknown accountKey', async () => {
        const { runtime } = createTestRuntime();
        await runtime.createInvoice({ accountKey: 'known-account', expectedAmountRaw: ONE_XNO });
        const invoices = await runtime.getInvoicesByAccountKey('unknown-account');
        expect(invoices).toEqual([]);
    });
});
describe('getInvoiceByAccountKeyAndInvoiceKey', () => {
    it('resolves one invoice by its compound application identity', async () => {
        const { runtime } = createTestRuntime();
        const invoice = await runtime.createInvoice({ accountKey: 'acct-recovery', invoiceKey: 'game-123', expectedAmountRaw: ONE_XNO });
        await runtime.createInvoice({ accountKey: 'acct-recovery', invoiceKey: 'game-456', expectedAmountRaw: ONE_XNO });
        expect((await runtime.getInvoiceByAccountKeyAndInvoiceKey('acct-recovery', 'game-123'))?.id).toBe(invoice.id);
        expect(await runtime.getInvoiceByAccountKeyAndInvoiceKey('acct-recovery', 'missing')).toBeUndefined();
    });
});
describe('cancelInvoice', () => {
    it('cancels an open invoice', async () => {
        const { runtime } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        const canceled = await runtime.cancelInvoice(invoice.id);
        expect(canceled.status).toBe('canceled');
        expect(canceled.canceledAt).toBeTruthy();
    });
    it('is idempotent by key', async () => {
        const { runtime } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        const first = await runtime.cancelInvoice(invoice.id, 'inv-cancel-1');
        const second = await runtime.cancelInvoice(invoice.id, 'inv-cancel-1');
        expect(first.id).toBe(second.id);
        expect(second.status).toBe('canceled');
    });
});
describe('handleConfirmedBlock', () => {
    it('records payment and completes invoice on full amount', async () => {
        const { runtime } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: invoice.payAddress, amountRaw: ONE_XNO }));
        const payments = await runtime.getPaymentsByInvoice(invoice.id);
        const updated = await runtime.getInvoice(invoice.id);
        expect(payments).toHaveLength(1);
        expect(payments[0].status).toBe('confirmed');
        expect(updated.status).toBe('completed');
        expect(updated.receivedAmountRaw).toBe(ONE_XNO);
    });
    it('uses the default watcher forwarding path without crediting the incoming send as recipient state', async () => {
        const { runtime } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        let currentAccount = {
            id: 'managed-recipient',
            accountKey: 'managed-recipient',
            type: 'managed',
            address: invoice.payAddress,
            label: null,
            balanceRaw: '0',
            pendingRaw: '0',
            frontier: null,
            representative: null,
            derivationIndex: 2 ** 31,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const accountStore = {
            create: async (account) => account,
            get: async (id) => id === currentAccount.id ? currentAccount : undefined,
            getByAddress: async (address) => address === currentAccount.address ? currentAccount : undefined,
            list: async () => [currentAccount],
            update: vi.fn(async (_id, patch) => {
                currentAccount = { ...currentAccount, ...patch };
                return currentAccount;
            }),
            delete: async () => true,
        };
        runtime.accountStore = accountStore;
        const accountInfo = vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValue({
            frontier: 'receive-frontier',
            balance: ONE_XNO,
            representative: 'nano_1representative',
            blockCount: 2,
        });
        const sync = new AccountStateSync({ getClient: () => ({ accountInfo }) }, accountStore, { addAccount: vi.fn(), removeAccount: vi.fn() }, undefined, (block) => runtime.handleConfirmedBlock(block), { reconcileIntervalMs: 10, initialSyncDelayMs: 0 });
        let recoveredSync;
        try {
            await sync.addAccount(currentAccount.address);
            const block = makeBlock({
                blockHash: 'confirmed-incoming-send',
                recipientAccount: currentAccount.address,
                amountRaw: ONE_XNO,
            });
            await sync.handleConfirmedBlock(block);
            await sync.handleConfirmedBlock(block);
            expect(currentAccount).toMatchObject({ balanceRaw: '0', frontier: null });
            expect(accountStore.update).not.toHaveBeenCalled();
            expect(await runtime.getPaymentsByInvoice(invoice.id)).toHaveLength(1);
            vi.useFakeTimers();
            sync.start();
            await vi.advanceTimersByTimeAsync(10);
            expect(accountStore.update).toHaveBeenCalledTimes(1);
            expect(accountStore.update).toHaveBeenCalledWith('managed-recipient', {
                balanceRaw: ONE_XNO,
                frontier: 'receive-frontier',
            });
            expect(currentAccount).toMatchObject({ balanceRaw: ONE_XNO, frontier: 'receive-frontier' });
            const recoveredRuntime = new Runtime({
                accountStore,
                invoiceStore: runtime.invoiceStore,
                paymentStore: runtime.paymentStore,
            });
            recoveredSync = new AccountStateSync({ getClient: () => ({ accountInfo }) }, accountStore, { addAccount: vi.fn(), removeAccount: vi.fn() }, undefined, (replayedBlock) => recoveredRuntime.handleConfirmedBlock(replayedBlock), { reconcileIntervalMs: 10, initialSyncDelayMs: 0 });
            await recoveredSync.addAccount(currentAccount.address);
            await recoveredSync.handleConfirmedBlock(block);
            expect(accountStore.update).toHaveBeenCalledTimes(1);
            expect(currentAccount).toMatchObject({ balanceRaw: ONE_XNO, frontier: 'receive-frontier' });
            expect(await recoveredRuntime.getPaymentsByInvoice(invoice.id)).toHaveLength(1);
        }
        finally {
            sync.stop();
            recoveredSync?.stop();
            vi.useRealTimers();
        }
    });
    it('emits canonical invoice payment events', async () => {
        const { runtime, deliveredEvents } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        await runtime.handleConfirmedBlock(makeBlock({
            recipientAccount: invoice.payAddress,
            senderAccount: TEST_ACCOUNT_2,
            amountRaw: ONE_XNO,
        }));
        const types = deliveredEvents.map((e) => e.event.type);
        expect(types).toContain('invoice.payment_received');
        expect(types).toContain('invoice.payment_confirmed');
        expect(types).toContain('invoice.completed');
    });
    it('is idempotent for duplicate block hash', async () => {
        const { runtime, deliveredEvents } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        const block = makeBlock({ recipientAccount: invoice.payAddress, amountRaw: HALF_XNO });
        await runtime.handleConfirmedBlock(block);
        await runtime.handleConfirmedBlock(block);
        const payments = await runtime.getPaymentsByInvoice(invoice.id);
        const confirmedEvents = deliveredEvents.filter((e) => e.event.type === 'invoice.payment_confirmed');
        expect(payments).toHaveLength(1);
        expect(confirmedEvents).toHaveLength(1);
    });
});
describe('getAccount', () => {
    it('returns live chain state without writing the account projection', async () => {
        const { runtime } = createTestRuntime();
        const account = {
            id: 'managed-account',
            accountKey: 'managed-account',
            type: 'managed',
            address: TEST_ACCOUNT_2,
            label: null,
            balanceRaw: '0',
            pendingRaw: '0',
            frontier: null,
            representative: null,
            derivationIndex: 2 ** 31,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        const update = vi.fn(async (_id, patch) => ({ ...account, ...patch }));
        runtime.accountStore = {
            get: vi.fn().mockResolvedValue(account),
            update,
        };
        runtime.rpcPool = {
            getClient: () => ({
                accountInfo: vi.fn().mockResolvedValue({
                    frontier: 'receive-frontier',
                    balance: ONE_XNO,
                    representative: 'nano_1representative',
                }),
            }),
        };
        const current = await runtime.getAccount(account.id);
        expect(current).toMatchObject({
            balanceRaw: ONE_XNO,
            frontier: 'receive-frontier',
            representative: 'nano_1representative',
        });
        expect(update).not.toHaveBeenCalled();
    });
});
describe('global event polling', () => {
    it('returns paginated canonical events', async () => {
        const { runtime } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: invoice.payAddress, amountRaw: ONE_XNO }));
        const firstPage = await runtime.listEvents({ limit: 2 });
        expect(firstPage.data.length).toBeLessThanOrEqual(2);
        expect(firstPage.data.length).toBeGreaterThan(0);
        expect(firstPage.nextCursor === null || typeof firstPage.nextCursor === 'string').toBe(true);
        const secondPage = await runtime.listEvents({ limit: 2, after: firstPage.nextCursor ?? undefined });
        expect(Array.isArray(secondPage.data)).toBe(true);
    });
});
describe('caller-signed block confirmation recovery', () => {
    it('feeds a confirmed caller-signed send into invoice matching immediately', async () => {
        const { runtime, deliveredEvents } = createTestRuntime();
        const invoice = await createTestInvoice(runtime);
        const blockHash = 'C'.repeat(64);
        const blockInfo = vi.fn().mockResolvedValue({
            confirmed: true,
            subtype: 'send',
            blockAccount: TEST_ACCOUNT_2,
            recipientAccount: invoice.payAddress,
            amount: ONE_XNO,
            localTimestamp: String(Math.floor(Date.now() / 1000)),
        });
        runtime.rpcPool = { getClient: () => ({ blockInfo }) };
        runtime.trackBlockConfirmation(blockHash);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect((await runtime.getInvoice(invoice.id))?.status).toBe('completed');
        expect(deliveredEvents.some((entry) => entry.event.type === 'invoice.completed')).toBe(true);
    });
    it('re-arms unfinished published blocks after runtime startup', async () => {
        const events = [{
                sequence: 1,
                id: 'published-1',
                type: 'block.published',
                timestamp: new Date().toISOString(),
                data: { blockHash: 'A'.repeat(64) },
                resourceId: 'A'.repeat(64),
                resourceType: 'block',
            }];
        const eventStore = {
            append: async (event) => { events.push({ ...event, sequence: events.length + 1 }); },
            list: async (options) => events.filter((event) => !options?.type || event.type === options.type),
        };
        const blockInfo = vi.fn()
            .mockResolvedValueOnce({ confirmed: false })
            .mockResolvedValueOnce({ confirmed: true });
        const runtime = new Runtime({
            v2EventStore: eventStore,
            rpcPool: { getClient: () => ({ blockInfo }) },
            blockConfirmationIntervalMs: 1,
            blockConfirmationTimeoutMs: 100,
        });
        runtime.start();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(blockInfo).toHaveBeenCalledWith('A'.repeat(64));
        expect(events.filter((event) => event.type === 'block.confirmed')).toHaveLength(1);
        runtime.stop();
    });
    it('does not re-arm blocks that already have a terminal event', async () => {
        const hash = 'B'.repeat(64);
        const events = [
            {
                sequence: 1,
                id: 'published-2',
                type: 'block.published',
                timestamp: new Date().toISOString(),
                data: { blockHash: hash },
                resourceId: hash,
                resourceType: 'block',
            },
            {
                sequence: 2,
                id: 'confirmed-2',
                type: 'block.confirmed',
                timestamp: new Date().toISOString(),
                data: { blockHash: hash },
                resourceId: hash,
                resourceType: 'block',
            },
        ];
        const blockInfo = vi.fn();
        const runtime = new Runtime({
            v2EventStore: { append: async () => { }, list: async (options) => events.filter((event) => !options?.type || event.type === options.type) },
            rpcPool: { getClient: () => ({ blockInfo }) },
        });
        runtime.start();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(blockInfo).not.toHaveBeenCalled();
        runtime.stop();
    });
});
describe('deleteAccount', () => {
    function setup(balanceRaw = '0', pendingRaw = '0', hasSendHistory = false) {
        const account = {
            id: 'account-1',
            accountKey: 'merchant:treasury',
            type: 'managed',
            address: 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
            label: null,
            balanceRaw,
            pendingRaw,
            frontier: null,
            representative: null,
            derivationIndex: 2 ** 31,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        let current = account;
        const accountStore = {
            create: async (value) => value,
            get: async () => current,
            getByAddress: async () => current,
            list: async () => current ? [current] : [],
            update: async (_id, patch) => ({ ...account, ...patch }),
            delete: async () => { current = undefined; return true; },
        };
        const events = [];
        const eventStore = {
            append: async (event) => { events.push(event); },
            list: async () => events,
        };
        const send = {
            id: 'send-1',
            accountId: account.id,
            destination: account.address,
            amountRaw: '1',
            status: 'confirmed',
            blockHash: 'A'.repeat(64),
            idempotencyKey: 'send-key',
            createdAt: new Date().toISOString(),
            publishedAt: new Date().toISOString(),
            confirmedAt: new Date().toISOString(),
        };
        const sendStore = hasSendHistory ? {
            create: async (value) => value,
            get: async () => send,
            listByAccount: async () => [send],
            listByStatus: async () => [],
            getByIdempotencyKey: async () => send,
            getByBlockHash: async () => send,
            update: async () => send,
        } : undefined;
        return { runtime: new Runtime({ accountStore, sendStore, v2EventStore: eventStore }), events };
    }
    it('removes an empty account and persists account.removed', async () => {
        const { runtime, events } = setup();
        const removed = await runtime.deleteAccount('account-1', 'delete-1');
        expect(removed?.id).toBe('account-1');
        expect(await runtime.getAccount('account-1')).toBeUndefined();
        expect(events.at(-1)?.type).toBe('account.removed');
    });
    it('refuses removal while funds remain', async () => {
        const { runtime } = setup('1');
        await expect(runtime.deleteAccount('account-1', 'delete-1')).rejects.toThrow('zero balance');
    });
    it('preserves send audit history by refusing account removal', async () => {
        const { runtime } = setup('0', '0', true);
        await expect(runtime.deleteAccount('account-1', 'delete-1')).rejects.toThrow('audit records');
    });
});
describe('xnoToRaw', () => {
    it('converts valid values and rejects invalid values', () => {
        expect(xnoToRaw('1')).toBe('1000000000000000000000000000000');
        expect(xnoToRaw('0.001')).toBe('1000000000000000000000000000');
        expect(() => xnoToRaw('')).toThrow('Invalid XNO amount');
        expect(() => xnoToRaw('0')).toThrow('must be greater than zero');
    });
});
//# sourceMappingURL=runtime.test.js.map