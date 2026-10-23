import { describe, it, expect, vi } from 'vitest';
import type { Account, AccountStore, EventStore, RaiFlowEvent, Send, SendStore } from '@openrai/model';
import { Runtime, xnoToRaw } from '../runtime.js';
import { AccountStateSync } from '../account-state-sync.js';
import { createDatabase, createMigrationRunner, createSqliteDepositStore, createSqliteConfirmedDepositIngestStore } from '@openrai/storage';
import {
  ONE_XNO,
  HALF_XNO,
  TEST_ACCOUNT_2,
  createTestRuntime,
  createTestInvoice,
  makeBlock,
} from './helpers.js';

describe('minimum inbound amount', () => {
  it('confirms an outgoing send below the inbound minimum', async () => {
    const send = {
      id: 'small-send', status: 'published', blockHash: 'small-send-hash',
      source: { type: 'account' as const, accountId: 'source', address: TEST_ACCOUNT_2, derivationIndex: null },
      destination: TEST_ACCOUNT_2, amountRaw: '1',
      idempotencyKey: 'small-send', createdAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(), confirmedAt: null,
    } satisfies Send;
    const update = vi.fn(async (_id: string, patch: Partial<Send>) => ({ ...send, ...patch }));
    const sendStore = { getByBlockHash: vi.fn().mockResolvedValue(send), update } as unknown as SendStore;
    const runtime = new Runtime({ sendStore });
    const listener = vi.fn();
    runtime.on('*', listener);
    await runtime.handleConfirmedBlock(makeBlock({ blockHash: send.blockHash, recipientAccount: send.destination, amountRaw: '1' }));
    expect(update).toHaveBeenCalledWith(send.id, expect.objectContaining({ status: 'confirmed' }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'send.confirmed' }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('rejects new invoices below the minimum and accepts its exact boundary', async () => {
    const { runtime } = createTestRuntime({ minimumReceiveAmountXno: '0.001' });
    await expect(runtime.createInvoice({ accountKey: 'tiny', expectedAmountRaw: '1' })).rejects.toMatchObject({ code: 'bad_request' });
    const invoice = await runtime.createInvoice({ accountKey: 'boundary', invoiceKey: 'order', expectedAmount: '0.001' }, 'boundary-key');
    expect(invoice.expectedAmountRaw).toBe(xnoToRaw('0.001'));
    const { runtime: raised } = createTestRuntime({ minimumReceiveAmountXno: '1' });
    // Previously issued invoices keep their identity when replayed after a config change.
    (raised as any).invoiceStore = runtime.invoiceStore;
    const replay = await raised.createInvoice({ accountKey: 'boundary', invoiceKey: 'order', expectedAmount: '0.001' });
    expect(replay.id).toBe(invoice.id);
  });

  it('drops dust before SQLite writes during live delivery and replay, then admits the boundary', async () => {
    const db = createDatabase(':memory:');
    try {
      await createMigrationRunner(db).up();
      const minimum = xnoToRaw('0.001');
      const address = TEST_ACCOUNT_2;
      db.prepare(`INSERT INTO invoices (id, status, pay_address, expected_amount_raw, received_amount_raw, created_at, updated_at, completion_policy)
        VALUES ('invoice-min', 'open', ?, ?, '0', ?, ?, '{"type":"at_least"}')`).run(address, minimum, new Date().toISOString(), new Date().toISOString());
      db.prepare(`INSERT INTO invoice_accounts (account_key, invoice_key, derivation_index, address, created_at)
        VALUES ('minimum', 'invoice-min', 7, ?, ?)`).run(address, new Date().toISOString());
      const config = {
        minimumReceiveAmountXno: '0.001',
        depositStore: createSqliteDepositStore(db),
        confirmedDepositIngestStore: createSqliteConfirmedDepositIngestStore(db),
      };
      const runtime = new Runtime(config);
      const recovered = new Runtime(config);
      for (let i = 0; i < 50; i++) {
        const block = makeBlock({ recipientAccount: address, blockHash: `dust-${i}`, amountRaw: i === 0 ? '1' : (BigInt(minimum) - 1n).toString() });
        await runtime.handleConfirmedBlock(block);
        await recovered.handleConfirmedBlock({ ...block, alreadyReceived: true });
      }
      for (const table of ['deposits', 'payments', 'events', 'receive_tasks']) {
        expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
      }
      const boundary = makeBlock({ recipientAccount: address, blockHash: 'boundary', amountRaw: minimum });
      await runtime.handleConfirmedBlock(boundary);
      await recovered.handleConfirmedBlock(boundary);
      for (const table of ['deposits', 'payments', 'receive_tasks']) {
        expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(1);
      }
      expect(db.prepare('SELECT status FROM invoices WHERE id = ?').pluck().get('invoice-min')).toBe('completed');
    } finally {
      db.close();
    }
  });

  it('does not create in-memory payments, deposits or events for dust', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    const listener = vi.fn();
    const enqueueReceivables = vi.fn();
    const handleConfirmedReceiveBlock = vi.fn();
    (runtime as any).receiveOrchestrator = { enqueueReceivables, handleConfirmedReceiveBlock };
    runtime.on('*', listener);
    await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: invoice.payAddress, amountRaw: '1' }));
    expect(await runtime.getPaymentsByInvoice(invoice.id)).toHaveLength(0);
    expect(await runtime.getDepositsByAccountKey(invoice.accountKey)).toHaveLength(0);
    expect(enqueueReceivables).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(handleConfirmedReceiveBlock).toHaveBeenCalledOnce();
  });
});

describe('invoice settlement', () => {
  it('waits for receivables, queues one invoice sourced send, and emits invoice.swept on confirmation', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    await (runtime as any).invoiceStore.update(invoice.id, { status: 'completed' });

    const sends = new Map<string, Send>();
    const sendStore: SendStore = {
      async create(send) {
        if ([...sends.values()].some((existing) => existing.idempotencyKey === send.idempotencyKey)) throw new Error('duplicate key');
        sends.set(send.id, send);
        return send;
      },
      async get(id) { return sends.get(id); },
      async getByBlockHash(hash) { return [...sends.values()].find((send) => send.blockHash === hash); },
      async listByAccount(id) { return [...sends.values()].filter((send) => send.source.type === 'account' && send.source.accountId === id); },
      async listByStatus(status) { return [...sends.values()].filter((send) => send.status === status); },
      async getByIdempotencyKey(key) { return [...sends.values()].find((send) => send.idempotencyKey === key); },
      async update(id, patch) {
        const current = sends.get(id);
        if (!current) throw new Error('send missing');
        const updated = { ...current, ...patch };
        sends.set(id, updated);
        return updated;
      },
    };
    const accountsReceivable = vi.fn()
      .mockResolvedValueOnce([{ hash: 'still-pending', amount: '500' }])
      .mockResolvedValue([]);
    (runtime as any).autoSweepInvoices = true;
    (runtime as any).invoiceSweepDestination = TEST_ACCOUNT_2;
    (runtime as any).sendStore = sendStore;
    (runtime as any).rpcPool = { getClient: () => ({
      accountsReceivable,
      accountInfo: vi.fn().mockResolvedValue({ balance: '500' }),
    }) };
    const listener = vi.fn();
    runtime.on('*', listener);

    await runtime.runInvoiceSweepCheck();
    expect(sends.size).toBe(0);

    await (runtime as any).receiveTaskStore.create({
      accountAddress: invoice.payAddress,
      derivationIndex: invoice.derivationIndex,
      pendingBlockHash: 'failed-receive-hash',
      amountRaw: '500',
      status: 'failed',
      publishedAt: null,
      confirmedAt: null,
      failedAt: new Date().toISOString(),
      failReason: 'temporary receive failure',
      retryCount: 3,
    });

    await runtime.runInvoiceSweepCheck();
    expect(sends.size).toBe(1);
    const [sweep] = [...sends.values()];
    expect(sweep).toMatchObject({
      source: { type: 'invoice', invoiceId: invoice.id, address: invoice.payAddress, derivationIndex: invoice.derivationIndex },
      destination: TEST_ACCOUNT_2,
      amountRaw: '500',
      idempotencyKey: `invoice-sweep:${invoice.id}`,
      status: 'queued',
    });
    await runtime.runInvoiceSweepCheck();
    expect(sends.size).toBe(1);
    const confirmed = await sendStore.update(sweep!.id, { status: 'confirmed', confirmedAt: new Date().toISOString() });
    await Promise.all([runtime.runInvoiceSweepCheck(), runtime.runInvoiceSweepCheck()]);
    expect(confirmed.source.type).toBe('invoice');
    const sweptEvents = listener.mock.calls.filter(([event]) => event.type === 'invoice.swept');
    expect(sweptEvents).toHaveLength(1);
    expect(sweptEvents[0]![0].id).toBe(`invoice.swept:${invoice.id}`);
  });
});

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

  it('gives one-time invoices distinct destinations when no invoiceKey is supplied', async () => {
    const { runtime } = createTestRuntime();
    const first = await runtime.createInvoice({ accountKey: 'acct-no-reference', expectedAmountRaw: ONE_XNO });
    const second = await runtime.createInvoice({ accountKey: 'acct-no-reference', expectedAmountRaw: ONE_XNO });

    expect(first.invoiceKey).toBeNull();
    expect(second.invoiceKey).toBeNull();
    expect(first.derivationIndex).not.toBe(second.derivationIndex);
    expect(first.payAddress).not.toBe(second.payAddress);
  });

  it('applies a configured default expiry and rejects invalid or past explicit dates', async () => {
    const { runtime } = createTestRuntime({ defaultExpirySeconds: 120 });
    const now = Date.now();
    const invoice = await runtime.createInvoice({ accountKey: 'acct-expiry', expectedAmountRaw: ONE_XNO });

    expect(Date.parse(invoice.expiresAt!)).toBeGreaterThanOrEqual(now + 119_000);
    await expect(runtime.createInvoice({
      accountKey: 'acct-expiry', expectedAmountRaw: ONE_XNO, expiresAt: 'not-a-date',
    })).rejects.toThrow('valid date-time');
    await expect(runtime.createInvoice({
      accountKey: 'acct-expiry', expectedAmountRaw: ONE_XNO, expiresAt: '2000-01-01T00:00:00Z',
    })).rejects.toThrow('in the future');
  });

  it('is idempotent by key and returns the original invoice', async () => {
    const { runtime } = createTestRuntime();
    const inv1 = await runtime.createInvoice({ accountKey: 'acct-1', expectedAmountRaw: ONE_XNO }, 'inv-create-1');
    const inv2 = await runtime.createInvoice({ accountKey: 'acct-1', expectedAmountRaw: ONE_XNO }, 'inv-create-1');

    expect(inv1.id).toBe(inv2.id);
    expect(inv1.payAddress).toBe(inv2.payAddress);
  });
});

describe('queueSend idempotency', () => {
  it('returns one send for concurrent retries and rejects a changed payload', async () => {
    const account: Account = {
      id: 'send-account',
      accountKey: 'send-account',
      type: 'managed',
      address: TEST_ACCOUNT_2,
      label: null,
      balanceRaw: '0',
      pendingRaw: '0',
      frontier: null,
      representative: null,
      derivationIndex: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const sends = new Map<string, Send>();
    const accountStore: AccountStore = {
      create: async (value) => value,
      get: async (id) => id === account.id ? account : undefined,
      getByAddress: async () => undefined,
      list: async () => [account],
      update: async () => account,
      delete: async () => true,
    };
    const sendStore: SendStore = {
      async create(send) {
        if ([...sends.values()].some((existing) => existing.idempotencyKey === send.idempotencyKey)) {
          throw new Error('UNIQUE constraint failed: sends.idempotency_key');
        }
        sends.set(send.id, send);
        return send;
      },
      async get(id) { return sends.get(id); },
      async getByBlockHash(hash) { return [...sends.values()].find((send) => send.blockHash === hash); },
      async listByAccount(id) { return [...sends.values()].filter((send) => send.source.type === 'account' && send.source.accountId === id); },
      async listByStatus(status) { return [...sends.values()].filter((send) => send.status === status); },
      async getByIdempotencyKey(key) { return [...sends.values()].find((send) => send.idempotencyKey === key); },
      async update(id, patch) {
        const send = sends.get(id);
        if (!send) throw new Error(`Send ${id} not found`);
        const updated = { ...send, ...patch };
        sends.set(id, updated);
        return updated;
      },
    };
    const runtime = new Runtime({ accountStore, sendStore });
    const request = {
      accountId: account.id,
      destination: 'xrb_3hsbezen1yu6egfh7ijbx4cbuk39uf5b5nofr7e3sq6d8iip89b5j8ff3rbe',
      amountRaw: ONE_XNO,
      idempotencyKey: 'same-send-key',
    };

    const [first, replay] = await Promise.all([runtime.queueSend(request), runtime.queueSend(request)]);
    expect(first.id).toBe(replay.id);
    expect(sends.size).toBe(1);
    await expect(runtime.queueSend({ ...request, amountRaw: HALF_XNO })).rejects.toThrow('different send request');
  });
});

describe('createInvoice — accountKey required', () => {
  it('rejects with error when accountKey is missing/empty', async () => {
    const { runtime } = createTestRuntime();

    await expect(
      runtime.createInvoice({ expectedAmountRaw: ONE_XNO } as never),
    ).rejects.toThrow('accountKey is required');
    await expect(
      runtime.createInvoice({ accountKey: '', expectedAmountRaw: ONE_XNO }),
    ).rejects.toThrow('accountKey is required');
  });

  it('same accountKey + same invoiceKey → same invoice across two createInvoice calls', async () => {
    const { runtime } = createTestRuntime();

    const inv1 = await runtime.createInvoice({
      accountKey: 'acct-stable',
      invoiceKey: 'inv-key-1',
      expectedAmountRaw: ONE_XNO,
    });
    const inv2 = await runtime.createInvoice({
      accountKey: 'acct-stable',
      invoiceKey: 'inv-key-1',
      expectedAmountRaw: ONE_XNO,
    });

    expect(inv1.id).toBe(inv2.id);
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
    const replay = await runtime.createInvoice({ accountKey: 'acct-recovery', invoiceKey: 'game-123', expectedAmountRaw: ONE_XNO });
    await runtime.createInvoice({ accountKey: 'acct-recovery', invoiceKey: 'game-456', expectedAmountRaw: ONE_XNO });

    expect(replay.id).toBe(invoice.id);
    expect((await runtime.getInvoiceByAccountKeyAndInvoiceKey('acct-recovery', 'game-123'))?.id).toBe(invoice.id);
    expect(await runtime.getInvoiceByAccountKeyAndInvoiceKey('acct-recovery', 'missing')).toBeUndefined();
  });

  it('rejects reuse of an application invoiceKey with a changed amount', async () => {
    const { runtime } = createTestRuntime();
    await runtime.createInvoice({ accountKey: 'acct-recovery', invoiceKey: 'game-123', expectedAmountRaw: ONE_XNO });

    await expect(runtime.createInvoice({
      accountKey: 'acct-recovery',
      invoiceKey: 'game-123',
      expectedAmountRaw: '200',
    })).rejects.toMatchObject({ code: 'conflict' });
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

  it('expires an open invoice once and does not overwrite a completed state', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    await (runtime as any).invoiceStore.update(invoice.id, { expiresAt: '2000-01-01T00:00:00.000Z' });

    await (runtime as any).runExpiryCheck();
    await (runtime as any).runExpiryCheck();
    expect((await runtime.getInvoice(invoice.id))?.status).toBe('expired');
    expect((await runtime.getEventsByInvoice(invoice.id)).filter((event) => event.type === 'invoice.expired')).toHaveLength(1);

    const completed = await createTestInvoice(runtime);
    await (runtime as any).invoiceStore.update(completed.id, {
      status: 'completed',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await (runtime as any).runExpiryCheck();
    expect((await runtime.getInvoice(completed.id))?.status).toBe('completed');
  });

  it('serializes cancellation against an already-due expiry', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    await (runtime as any).invoiceStore.update(invoice.id, { expiresAt: '2000-01-01T00:00:00.000Z' });

    await Promise.allSettled([
      runtime.cancelInvoice(invoice.id),
      (runtime as any).runExpiryCheck(),
    ]);

    const result = await runtime.getInvoice(invoice.id);
    expect(['canceled', 'expired']).toContain(result?.status);
    const lifecycleEvents = (await runtime.getEventsByInvoice(invoice.id))
      .filter((event) => event.type === 'invoice.canceled' || event.type === 'invoice.expired');
    expect(lifecycleEvents).toHaveLength(1);
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
    expect(payments[0]!.status).toBe('confirmed');
    expect(updated!.status).toBe('completed');
    expect(updated!.receivedAmountRaw).toBe(ONE_XNO);
  });

  it('uses the default watcher forwarding path without crediting the incoming send as recipient state', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    let currentAccount: Account = {
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
    const accountStore: AccountStore = {
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
    (runtime as any).accountStore = accountStore;

    const accountInfo = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        frontier: 'receive-frontier',
        balance: ONE_XNO,
        representative: 'nano_1representative',
        blockCount: 2,
      });
    const sync = new AccountStateSync(
      { getClient: () => ({ accountInfo }) } as any,
      accountStore,
      { addAccount: vi.fn(), removeAccount: vi.fn() },
      undefined,
      (block) => runtime.handleConfirmedBlock(block),
      { reconcileIntervalMs: 10, initialSyncDelayMs: 0 },
    );
    let recoveredSync: AccountStateSync | undefined;

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
      recoveredSync = new AccountStateSync(
        { getClient: () => ({ accountInfo }) } as any,
        accountStore,
        { addAccount: vi.fn(), removeAccount: vi.fn() },
        undefined,
        (replayedBlock) => recoveredRuntime.handleConfirmedBlock(replayedBlock),
        { reconcileIntervalMs: 10, initialSyncDelayMs: 0 },
      );
      await recoveredSync.addAccount(currentAccount.address);
      await recoveredSync.handleConfirmedBlock(block);

      expect(accountStore.update).toHaveBeenCalledTimes(1);
      expect(currentAccount).toMatchObject({ balanceRaw: ONE_XNO, frontier: 'receive-frontier' });
      expect(await recoveredRuntime.getPaymentsByInvoice(invoice.id)).toHaveLength(1);
    } finally {
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

  it('queues receive discovery for an invoice address even after the invoice is complete', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    await (runtime as any).invoiceStore.update(invoice.id, { status: 'completed' });
    const enqueueReceivables = vi.fn().mockResolvedValue(undefined);
    const handleConfirmedReceiveBlock = vi.fn().mockResolvedValue(undefined);
    (runtime as any).receiveOrchestrator = { enqueueReceivables, handleConfirmedReceiveBlock };

    await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: invoice.payAddress, amountRaw: ONE_XNO }));

    expect(enqueueReceivables).toHaveBeenCalledWith(invoice.payAddress, invoice.derivationIndex);
    await expect(runtime.getDepositsByAccountKey(invoice.accountKey)).resolves.toMatchObject([
      {
        recipientAccount: invoice.payAddress,
        amountRaw: ONE_XNO,
        invoiceId: invoice.id,
        disposition: 'late',
      },
    ]);
  });

  it('persists and deduplicates confirmed deposits independently of invoice payments', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    const block = makeBlock({ recipientAccount: invoice.payAddress, amountRaw: HALF_XNO });

    await runtime.handleConfirmedBlock(block);
    await runtime.handleConfirmedBlock(block);

    const deposits = await runtime.getDepositsByAccountKey(invoice.accountKey);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({
      blockHash: block.blockHash,
      recipientAccount: invoice.payAddress,
      senderAccount: block.senderAccount,
      amountRaw: HALF_XNO,
      invoiceId: invoice.id,
      disposition: 'partial',
      confirmedAt: block.confirmedAt,
    });
    expect(await runtime.getPaymentsByInvoice(invoice.id)).toHaveLength(1);
  });

  it('dispatches events after the atomic ingest store has persisted them', async () => {
    const event: RaiFlowEvent = {
      id: 'deposit-event-1',
      type: 'invoice.payment_confirmed',
      timestamp: new Date().toISOString(),
      data: {},
      resourceId: 'invoice-1',
      resourceType: 'invoice',
    };
    const ingest = vi.fn().mockResolvedValue({
      created: true,
      deposit: {
        id: 'deposit-1',
        blockHash: 'block-1',
        recipientAccount: 'nano_atomic_recipient',
        senderAccount: 'nano_sender',
        amountRaw: ONE_XNO,
        invoiceId: 'invoice-1',
        disposition: 'matched',
        confirmedAt: new Date().toISOString(),
      },
      events: [event],
    });
    const append = vi.fn();
    const listener = vi.fn();
    const runtime = new Runtime({
      depositStore: {
        createIfAbsent: vi.fn(),
        getByBlockHash: vi.fn(),
        get: vi.fn(),
        listByRecipientAccounts: vi.fn(),
      },
      confirmedDepositIngestStore: { ingest },
      eventStore: { append, list: vi.fn().mockResolvedValue([]) },
    });
    runtime.on('*', listener);

    await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: 'nano_atomic_recipient' }));

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(event);
  });
});

describe('getAccount', () => {
  it('returns live chain state without writing the account projection', async () => {
    const { runtime } = createTestRuntime();
    const account: Account = {
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
    const update = vi.fn(async (_id: string, patch: Partial<Account>) => ({ ...account, ...patch }));
    (runtime as any).accountStore = {
      get: vi.fn().mockResolvedValue(account),
      update,
    };
    (runtime as any).rpcPool = {
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
    (runtime as any).rpcPool = { getClient: () => ({ blockInfo }) };
    (runtime as any).trackBlockConfirmation(blockHash);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect((await runtime.getInvoice(invoice.id))?.status).toBe('completed');
    expect(deliveredEvents.some((entry) => entry.event.type === 'invoice.completed')).toBe(true);
  });

  it('re-arms unfinished published blocks after runtime startup', async () => {
    const events: import('@openrai/model').RaiFlowEvent[] = [{
      sequence: 1,
      id: 'published-1',
      type: 'block.published',
      timestamp: new Date().toISOString(),
      data: { blockHash: 'A'.repeat(64) },
      resourceId: 'A'.repeat(64),
      resourceType: 'block',
    }];
    const eventStore: EventStore = {
      append: async (event) => { events.push({ ...event, sequence: events.length + 1 }); },
      list: async (options) => events.filter((event) => !options?.type || event.type === options.type),
    };
    const blockInfo = vi.fn()
      .mockResolvedValueOnce({ confirmed: false })
      .mockResolvedValueOnce({ confirmed: true });
    const runtime = new Runtime({
      eventStore: eventStore,
      rpcPool: { getClient: () => ({ blockInfo } as any) } as any,
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
    const events: import('@openrai/model').RaiFlowEvent[] = [
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
      eventStore: { append: async () => {}, list: async (options) => events.filter((event) => !options?.type || event.type === options.type) },
      rpcPool: { getClient: () => ({ blockInfo } as any) } as any,
    });

    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(blockInfo).not.toHaveBeenCalled();
    runtime.stop();
  });
});

describe('deleteAccount', () => {
  function setup(balanceRaw = '0', pendingRaw = '0', hasSendHistory = false) {
    const account: Account = {
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
    let current: Account | undefined = account;
    const accountStore: AccountStore = {
      create: async (value) => value,
      get: async () => current,
      getByAddress: async () => current,
      list: async () => current ? [current] : [],
      update: async (_id, patch) => ({ ...account, ...patch }),
      delete: async () => { current = undefined; return true; },
    };
    const events: import('@openrai/model').RaiFlowEvent[] = [];
    const eventStore: EventStore = {
      append: async (event) => { events.push(event); },
      list: async () => events,
    };
    const send: Send = {
      id: 'send-1',
      source: { type: 'account', accountId: account.id, address: account.address, derivationIndex: account.derivationIndex },
      destination: account.address,
      amountRaw: '1',
      status: 'confirmed',
      blockHash: 'A'.repeat(64),
      idempotencyKey: 'send-key',
      createdAt: new Date().toISOString(),
      publishedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    };
    const sendStore: SendStore | undefined = hasSendHistory ? {
      create: async (value) => value,
      get: async () => send,
      listByAccount: async () => [send],
      listByStatus: async () => [],
      getByIdempotencyKey: async () => send,
      getByBlockHash: async () => send,
      update: async () => send,
    } : undefined;
    return { runtime: new Runtime({ accountStore, sendStore, eventStore: eventStore }), events };
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
