import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustodyEngine } from '@openrai/custody';
import {
  createDatabase,
  createMigrationRunner,
  createSqliteAccountOperationLeaseStore,
  createSqliteAccountStore,
  createSqliteConfirmedDepositIngestStore,
  createSqliteDepositStore,
  createSqliteRefundStore,
  createSqliteEventStore,
  createSqliteIdempotencyReplayStore,
  createSqliteInvoiceAccountStore,
  createSqliteInvoiceStore,
  createSqlitePaymentStore,
  createSqliteReceiveBlockIntentStore,
  createSqliteReceiveTaskStore,
  createSqliteSendBlockIntentStore,
  createSqliteSendStore,
  createSqliteWebhookOutboxStore,
  createSqliteWebhookStore,
} from '@openrai/storage';
import { createEventBus, createPersistentEventStore } from '@openrai/events';
import { Runtime } from '../runtime.js';
import { createHandler } from '../handler.js';
import {
  HALF_XNO,
  ONE_XNO,
  TEST_ACCOUNT_2,
  createTestConfig,
  makeBlock,
  parseJson,
} from './helpers.js';

const SEED = '9f4f272617f01c4db7d5ebc0f4ef5baf6286f09ad7f295d08f6f41e88c2e6d14';
const DESTINATION = TEST_ACCOUNT_2;

function createControlledNode() {
  const accepted = new Set<string>();
  const confirmed = new Set<string>();
  let loseFirstProcessResponse = false;
  let confirmFutureBlocks = false;
  const client = {
    async healthCheck() {},
    async accountInfo() {
      return { frontier: 'frontier-before-send', balance: (10n * BigInt(ONE_XNO)).toString() };
    },
    async accountsReceivable() { return []; },
    async process(blockJson: string) {
      const parsed = JSON.parse(blockJson) as { hash?: string };
      const hash = parsed.hash ?? 'controlled-block-hash';
      if (accepted.has(hash)) throw new Error('Old block');
      accepted.add(hash);
      if (confirmFutureBlocks) confirmed.add(hash);
      if (loseFirstProcessResponse) {
        loseFirstProcessResponse = false;
        throw new Error('connection lost after node accepted the block');
      }
      return { hash };
    },
    async blockInfo(hash: string) {
      return accepted.has(hash) ? { confirmed: confirmed.has(hash) } : undefined;
    },
  };
  return {
    client,
    rpcPool: { getClient: () => client } as never,
    accepted,
    confirmAll() { confirmFutureBlocks = true; for (const hash of accepted) confirmed.add(hash); },
    loseFirstResponse() { loseFirstProcessResponse = true; },
  };
}

function createDurableRuntime(
  db: ReturnType<typeof createDatabase>,
  node = createControlledNode(),
  options: { autoSweepInvoices?: boolean; invoiceSweepDestination?: string } = {},
) {
  const invoiceStore = createSqliteInvoiceStore(db);
  const paymentStore = createSqlitePaymentStore(db);
  const eventStore = createPersistentEventStore(createSqliteEventStore(db), createEventBus());
  const custody = createCustodyEngine({
    seed: SEED,
    workProvider: { generate: async () => 'mocked-work' as never },
    representative: 'nano_3arg3asgtigae3zha8xw5rh4n83d3f4h6f9y4w6q37fph4n8tqbo6j8qzszk',
    derivationStartIndex: { invoice: 0, managed: 1_000_000 },
  });
  custody.loadSeed(SEED);
  const destination = options.invoiceSweepDestination ?? custody.deriveManagedAccount({ index: 900_000 });
  let sendBlockNumber = 0;
  let receiveBlockNumber = 0;
  vi.spyOn(custody, 'signSend').mockImplementation(async (source, _destination, balance, frontier) => {
    const hash = `controlled-send-${++sendBlockNumber}`;
    return {
      contents: JSON.stringify({ type: 'state', hash, account: source, previous: frontier, balance, link: DESTINATION }),
      signature: 'controlled-signature',
      hash,
    };
  });
  vi.spyOn(custody, 'signReceive').mockImplementation(async (account, pendingHash, balance, frontier) => {
    const hash = `controlled-receive-${++receiveBlockNumber}`;
    return {
      contents: JSON.stringify({ type: 'state', hash, account, previous: frontier, balance, link: pendingHash }),
      signature: 'controlled-signature',
      hash,
    };
  });
  const runtime = new Runtime({
    invoiceStore,
    paymentStore,
    eventStore,
    
    accountStore: createSqliteAccountStore(db),
    sendStore: createSqliteSendStore(db),
    invoiceAccountStore: createSqliteInvoiceAccountStore(db),
    receiveTaskStore: createSqliteReceiveTaskStore(db),
    accountOperationLeaseStore: createSqliteAccountOperationLeaseStore(db),
    sendBlockIntentStore: createSqliteSendBlockIntentStore(db),
    receiveBlockIntentStore: createSqliteReceiveBlockIntentStore(db),
    depositStore: createSqliteDepositStore(db),
    refundStore: createSqliteRefundStore(db),
    confirmedDepositIngestStore: createSqliteConfirmedDepositIngestStore(db),
    webhookEndpointStore: createSqliteWebhookStore(db),
    webhookOutboxStore: createSqliteWebhookOutboxStore(db),
    idempotencyStore: createSqliteIdempotencyReplayStore(db),
    custodyEngine: custody,
    rpcPool: node.rpcPool,
    autoSweepInvoices: options.autoSweepInvoices,
    invoiceSweepDestination: options.autoSweepInvoices ? destination : options.invoiceSweepDestination,
    blockConfirmationIntervalMs: 10,
    blockConfirmationTimeoutMs: 1_000,
  });
  const handler = createHandler(runtime, createTestConfig({ apiKey: undefined }));
  return { runtime, handler, node, destination };
}

function apiRequest(method: string, path: string, body?: unknown, key?: string): Request {
  const headers = new Headers();
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (key) headers.set('Idempotency-Key', key);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function openDatabase() {
  const db = createDatabase(':memory:');
  await createMigrationRunner(db).up();
  return db;
}

async function flushPromiseWork() {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('public commerce recovery through SQLite and HTTP', () => {
  it('recovers the exact send intent after node acceptance and replays duplicate HTTP requests', async () => {
    vi.useFakeTimers();
    const db = await openDatabase();
    const node = createControlledNode();
    node.loseFirstResponse();
    const first = createDurableRuntime(db, node);
    try {
      const accountResponse = await first.handler(apiRequest('POST', '/v1/accounts', {
        type: 'managed', accountKey: 'recovery-source',
      }, 'account-create'));
      expect(accountResponse.status, await accountResponse.clone().text()).toBe(201);
      const account = await parseJson(accountResponse) as { id: string };
      const request = () => apiRequest('POST', `/v1/accounts/${account.id}/sends`, {
        destination: first.destination,
        amountRaw: HALF_XNO,
      }, 'same-send-request');
      const queued = await first.handler(request());
      const replay = await first.handler(request());
      expect(queued.status, await queued.clone().text()).toBe(201);
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject(await queued.clone().json());

      const signed = vi.mocked(first.runtime.custodyEngine!.signSend);
      first.runtime.start();
      await vi.advanceTimersByTimeAsync(5_000);
      first.runtime.stop();

      const intent = db.prepare('SELECT block_hash, block_json FROM send_block_intents').get() as {
        block_hash: string;
        block_json: string;
      };
      expect(intent.block_hash).toBe('controlled-send-1');
      expect(signed).toHaveBeenCalledTimes(1);
      expect(node.accepted.has(intent.block_hash)).toBe(true);
      expect(db.prepare('SELECT status FROM sends').pluck().get()).toBe('queued');

      const restarted = createDurableRuntime(db, node);
      restarted.runtime.start();
      await vi.advanceTimersByTimeAsync(5_000);
      restarted.runtime.stop();
      const send = db.prepare('SELECT status, block_hash FROM sends').get() as { status: string; block_hash: string };
      expect(send).toEqual({ status: 'published', block_hash: intent.block_hash });
      expect(db.prepare('SELECT block_json FROM send_block_intents').pluck().get()).toBe(intent.block_json);
      expect(node.accepted.size).toBe(1);
      const events = await createSqliteEventStore(db).list({ type: 'send.published' });
      expect(events).toHaveLength(1);
    } finally {
      first.runtime.stop();
      db.close();
    }
  });

  it('keeps simultaneous customer orders distinct and deduplicates partial, excess, and late deposits after restart', async () => {
    const db = await openDatabase();
    const first = createDurableRuntime(db);
    try {
      const createInvoice = (accountKey: string, key: string) => first.handler(apiRequest('POST', '/v1/invoices', {
        accountKey,
        expectedAmountRaw: ONE_XNO,
      }, key));
      const [firstResponse, secondResponse] = await Promise.all([
        createInvoice('customer-one', 'invoice-one'),
        createInvoice('customer-two', 'invoice-two'),
      ]);
      expect(firstResponse.status, await firstResponse.clone().text()).toBe(201);
      expect(secondResponse.status, await secondResponse.clone().text()).toBe(201);
      const firstInvoice = await firstResponse.json() as { id: string; payAddress: string };
      const secondInvoice = await secondResponse.json() as { id: string; payAddress: string };
      expect(firstInvoice.payAddress).not.toBe(secondInvoice.payAddress);

      const firstBlock = makeBlock({ blockHash: 'partial-payment', recipientAccount: firstInvoice.payAddress, amountRaw: HALF_XNO });
      await first.runtime.handleConfirmedBlock(firstBlock);
      const secondBlock = makeBlock({ blockHash: 'excess-payment', recipientAccount: firstInvoice.payAddress, amountRaw: (BigInt(HALF_XNO) + 1n).toString() });
      await first.runtime.handleConfirmedBlock(secondBlock);
      const lateBlock = makeBlock({ blockHash: 'late-payment', recipientAccount: firstInvoice.payAddress, amountRaw: HALF_XNO });
      await first.runtime.handleConfirmedBlock(lateBlock);

      expect(db.prepare('SELECT disposition FROM deposits WHERE block_hash = ?').pluck().get('partial-payment')).toBe('partial');
      expect(db.prepare('SELECT disposition FROM deposits WHERE block_hash = ?').pluck().get('excess-payment')).toBe('excess');
      expect(db.prepare('SELECT disposition FROM deposits WHERE block_hash = ?').pluck().get('late-payment')).toBe('late');
      expect(db.prepare('SELECT status FROM invoices WHERE id = ?').pluck().get(firstInvoice.id)).toBe('completed');

      const restarted = createDurableRuntime(db);
      await restarted.runtime.handleConfirmedBlock(firstBlock);
      await restarted.runtime.handleConfirmedBlock(secondBlock);
      await restarted.runtime.handleConfirmedBlock(lateBlock);
      expect(db.prepare('SELECT COUNT(*) FROM deposits').pluck().get()).toBe(3);
      expect(db.prepare('SELECT COUNT(*) FROM payments').pluck().get()).toBe(2);
      expect(await createSqliteEventStore(db).list({ type: 'invoice.payment_confirmed' })).toHaveLength(2);
      const replayResponse = await restarted.handler(apiRequest('POST', '/v1/invoices', {
        accountKey: 'customer-one', expectedAmountRaw: ONE_XNO,
      }, 'invoice-one'));
      const replayedInvoice = await replayResponse.json() as { id: string };
      expect(replayedInvoice.id).toBe(firstInvoice.id);
    } finally {
      first.runtime.stop();
      db.close();
    }
  });

  it('receives deposits while webhook delivery is down and resumes the durable event after restart', async () => {
    vi.useFakeTimers();
    const db = await openDatabase();
    const node = createControlledNode();
    const down = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('temporarily unavailable', { status: 503 }));
    const first = createDurableRuntime(db, node);
    try {
      const webhook = await first.handler(apiRequest('POST', '/v1/webhooks', {
        url: 'https://webhook.invalid/events', eventTypes: ['invoice.payment_confirmed'], secret: 'test-secret',
      }, 'webhook-create'));
      expect(webhook.status).toBe(201);
      const invoiceResponse = await first.handler(apiRequest('POST', '/v1/invoices', {
        accountKey: 'outage-customer', expectedAmountRaw: ONE_XNO,
      }, 'outage-invoice'));
      expect(invoiceResponse.status, await invoiceResponse.clone().text()).toBe(201);
      const invoice = await invoiceResponse.json() as { id: string; payAddress: string };

      await first.runtime.handleConfirmedBlock(makeBlock({
        blockHash: 'payment-during-webhook-outage', recipientAccount: invoice.payAddress,
      }));
      await flushPromiseWork();
      expect(db.prepare("SELECT COUNT(*) FROM webhook_outbox WHERE status = 'pending'").pluck().get()).toBe(1);

      first.runtime.start();
      await vi.advanceTimersByTimeAsync(500);
      first.runtime.stop();
      expect(down).toHaveBeenCalled();
      expect(db.prepare('SELECT status FROM receive_tasks WHERE pending_block_hash = ?').pluck().get('payment-during-webhook-outage')).toBe('published');
      expect(db.prepare('SELECT status FROM webhook_outbox').pluck().get()).toBe('pending');

      down.mockRestore();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      const restarted = createDurableRuntime(db, node);
      restarted.runtime.start();
      await vi.advanceTimersByTimeAsync(2_000);
      restarted.runtime.stop();
      expect(db.prepare('SELECT status, attempt_count FROM webhook_outbox').get()).toEqual({ status: 'delivered', attempt_count: 2 });
      expect(db.prepare('SELECT COUNT(*) FROM webhook_deliveries').pluck().get()).toBe(2);
      expect(db.prepare('SELECT status FROM receive_tasks WHERE pending_block_hash = ?').pluck().get('payment-during-webhook-outage')).toBe('published');
    } finally {
      first.runtime.stop();
      db.close();
    }
  });

  it('serializes a send against an in-flight receive on the same account', async () => {
    vi.useFakeTimers();
    const db = await openDatabase();
    const node = createControlledNode();
    const fixture = createDurableRuntime(db, node);
    let releaseReceive!: () => void;
    let receiveSigningStarted = false;
    const receiveGate = new Promise<void>((resolve) => { releaseReceive = resolve; });
    try {
      const accountResponse = await fixture.handler(apiRequest('POST', '/v1/accounts', {
        type: 'managed', accountKey: 'shared-operation-account',
      }, 'shared-account'));
      const account = await accountResponse.json() as { id: string; address: string };
      const sendResponse = await fixture.handler(apiRequest('POST', `/v1/accounts/${account.id}/sends`, {
        destination: fixture.destination,
        amountRaw: HALF_XNO,
      }, 'send-while-receiving'));
      expect(sendResponse.status).toBe(201);

      await fixture.runtime.handleConfirmedBlock(makeBlock({
        blockHash: 'incoming-to-shared-account', recipientAccount: account.address,
      }));
      vi.mocked(fixture.runtime.custodyEngine!.signReceive).mockImplementation(async (source, pendingHash, balance, frontier) => {
        receiveSigningStarted = true;
        await receiveGate;
        return {
          contents: JSON.stringify({ type: 'state', hash: 'controlled-receive-hash', account: source, previous: frontier, balance, link: pendingHash }),
          signature: 'controlled-signature',
          hash: 'controlled-receive-hash',
        };
      });

      fixture.runtime.start();
      await vi.advanceTimersByTimeAsync(500);
      await flushPromiseWork();
      expect(receiveSigningStarted).toBe(true);
      expect(db.prepare('SELECT status FROM receive_tasks').pluck().get()).toBe('processing');

      await vi.advanceTimersByTimeAsync(5_000);
      expect(vi.mocked(fixture.runtime.custodyEngine!.signSend)).not.toHaveBeenCalled();
      expect(db.prepare('SELECT status FROM sends').pluck().get()).toBe('queued');

      releaseReceive();
      await flushPromiseWork();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(db.prepare('SELECT status FROM receive_tasks').pluck().get()).toBe('published');
      expect(db.prepare('SELECT status FROM sends').pluck().get()).toBe('published');
      expect(vi.mocked(fixture.runtime.custodyEngine!.signSend)).toHaveBeenCalledOnce();
    } finally {
      releaseReceive();
      fixture.runtime.stop();
      db.close();
    }
  });

  it('recovers a queued invoice sweep after restart and emits one swept event on confirmation', async () => {
    vi.useFakeTimers();
    const db = await openDatabase();
    const node = createControlledNode();
    const first = createDurableRuntime(db, node, { autoSweepInvoices: true });
    try {
      const invoiceResponse = await first.handler(apiRequest('POST', '/v1/invoices', {
        accountKey: 'sweep-customer', expectedAmountRaw: ONE_XNO,
      }, 'sweep-invoice'));
      const invoice = await invoiceResponse.json() as { id: string; payAddress: string };
      await first.runtime.handleConfirmedBlock(makeBlock({
        blockHash: 'already-received-payment', recipientAccount: invoice.payAddress, alreadyReceived: true,
      }));
      await first.runtime.runInvoiceSweepCheck();
      expect(db.prepare('SELECT source_type, status FROM sends').get()).toEqual({ source_type: 'invoice', status: 'queued' });

      const restarted = createDurableRuntime(db, node, {
        autoSweepInvoices: true,
        invoiceSweepDestination: first.destination,
      });
      await restarted.runtime.runInvoiceSweepCheck();
      expect(db.prepare('SELECT COUNT(*) FROM sends').pluck().get()).toBe(1);
      node.confirmAll();
      restarted.runtime.start();
      await vi.advanceTimersByTimeAsync(5_000);
      restarted.runtime.stop();

      expect(db.prepare('SELECT status FROM sends').pluck().get()).toBe('confirmed');
      const swept = await createSqliteEventStore(db).list({ type: 'invoice.swept', resourceId: invoice.id });
      expect(swept).toHaveLength(1);
      expect(swept[0]?.id).toBe(`invoice.swept:${invoice.id}`);
    } finally {
      first.runtime.stop();
      db.close();
    }
  });

  it('queues only explicit idempotent refunds against the confirmed deposit amount', async () => {
    const db = await openDatabase();
    const fixture = createDurableRuntime(db);
    try {
      const account = await fixture.runtime.createManagedAccount({ accountKey: 'refund-source', idempotencyKey: 'managed-refund-source' });
      const deposit = await fixture.runtime.depositStore.createIfAbsent({
        id: 'refund-deposit', blockHash: 'refund-deposit-block', recipientAccount: account.address,
        senderAccount: 'nano_exchange_hot_wallet', amountRaw: ONE_XNO, invoiceId: null,
        disposition: 'unmatched', confirmedAt: new Date().toISOString(),
      });
      const path = `/v1/deposits/${deposit.id}/refunds`;
      const refundDestination = fixture.destination;
      const request = (amountRaw: string, key: string, destination = refundDestination) => apiRequest(
        'POST', path, { destination, amountRaw }, key,
      );

      const createdResponse = await fixture.handler(request(HALF_XNO, 'refund-request-1'));
      const responseBody = await createdResponse.json() as Record<string, unknown>;
      expect(createdResponse.status, JSON.stringify(responseBody)).toBe(201);
      const created = responseBody as { id: string; sendId: string; destination: string; status: string };
      expect(created.destination).toBe(refundDestination);
      expect(created.status).toBe('queued');
      expect(db.prepare('SELECT source_address, destination, amount_raw, status FROM sends').get()).toEqual({
        source_address: account.address,
        destination: refundDestination,
        amount_raw: HALF_XNO,
        status: 'queued',
      });

      const replayResponse = await fixture.handler(request(HALF_XNO, 'refund-request-1'));
      expect((await replayResponse.json() as { id: string }).id).toBe(created.id);
      const conflictResponse = await fixture.handler(request('1', 'refund-request-1'));
      expect(conflictResponse.status).toBe(409);
      const excessiveResponse = await fixture.handler(request(HALF_XNO + '1', 'refund-request-2'));
      expect(excessiveResponse.status).toBe(409);

      const listResponse = await fixture.handler(apiRequest('GET', path));
      expect(await listResponse.json()).toMatchObject({ data: [{ id: created.id, sendId: created.sendId, status: 'queued' }] });
      expect(db.prepare('SELECT COUNT(*) AS count FROM sends').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM refunds').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT destination FROM refunds').pluck().get()).toBe(refundDestination);
      expect((await fixture.runtime.getRefundsByDeposit(deposit.id))[0]?.destination).not.toBe(deposit.senderAccount);

      const invoice = await fixture.runtime.createInvoice({ accountKey: 'refund-invoice', expectedAmountRaw: ONE_XNO }, 'refund-invoice');
      const invoiceDeposit = await fixture.runtime.depositStore.createIfAbsent({
        id: 'refund-invoice-deposit', blockHash: 'refund-invoice-deposit-block', recipientAccount: invoice.payAddress,
        senderAccount: 'nano_exchange_hot_wallet', amountRaw: ONE_XNO, invoiceId: invoice.id,
        disposition: 'matched', confirmedAt: new Date().toISOString(),
      });
      const invoiceRefundResponse = await fixture.handler(apiRequest(
        'POST', `/v1/deposits/${invoiceDeposit.id}/refunds`,
        { destination: refundDestination, amountRaw: HALF_XNO }, 'invoice-refund-request',
      ));
      expect(invoiceRefundResponse.status).toBe(201);
      const invoiceRefund = await invoiceRefundResponse.json() as { sendId: string; invoiceId: string };
      expect(invoiceRefund.invoiceId).toBe(invoice.id);
      expect(db.prepare('SELECT source_type, source_invoice_id FROM sends WHERE id = ?').get(invoiceRefund.sendId))
        .toEqual({ source_type: 'invoice', source_invoice_id: invoice.id });
    } finally {
      fixture.runtime.stop();
      db.close();
    }
  });
});
