import { afterEach, describe, expect, it } from 'vitest';
import type { RaiFlowEvent, Refund, Send } from '@openrai/model';
import {
  createDatabase,
  createMigrationRunner,
  createSqliteEventStore,
  createSqliteWebhookStore,
  createSqliteWebhookOutboxStore,
  createSqliteAccountOperationLeaseStore,
  createSqliteSendBlockIntentStore,
  createSqliteSendStore,
  createSqliteReceiveBlockIntentStore,
  createSqliteDepositStore,
  createSqliteRefundStore,
  createSqliteConfirmedDepositIngestStore,
  StorageBudgetExceededError,
  createSqliteAccountHistoryRecoveryCursorStore,
  createSqliteInvoiceAccountStore,
  createSqliteInvoiceStore,
  SCHEMA_VERSION,
  type Database,
} from './index.js';

describe('v3 storage foundation', () => {
  let db: Database | undefined;

  afterEach(() => db?.close());

  async function seedInvoice(address: string, expectedAmountRaw = '100') {
    db!.prepare(`
      INSERT INTO invoices (
        id, status, pay_address, expected_amount_raw, received_amount_raw,
        created_at, updated_at, completion_policy
      ) VALUES ('invoice-atomic', 'open', ?, ?, '0', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.000Z', '{"type":"at_least"}')
    `).run(address, expectedAmountRaw);
    db!.prepare(`
      INSERT INTO invoice_accounts (account_key, invoice_key, derivation_index, address, created_at)
      VALUES ('customer-1', 'order-1', 7, ?, '2026-10-22T00:00:00.000Z')
    `).run(address);
  }

  it('creates a versioned v3 schema and monotonic event cursors', async () => {
    db = createDatabase(':memory:');
    const migrations = createMigrationRunner(db);
    await migrations.up();
    expect(db.prepare('SELECT version FROM schema_metadata WHERE id = 1').pluck().get()).toBe(SCHEMA_VERSION);

    const store = createSqliteEventStore(db);
    const makeEvent = (id: string): RaiFlowEvent => ({
      id,
      type: 'invoice.created',
      timestamp: new Date().toISOString(),
      data: {},
      resourceId: id,
      resourceType: 'invoice',
    });
    await store.append(makeEvent('z-random-id'));
    await store.append(makeEvent('a-random-id'));

    const firstPage = await store.list({ limit: 1 });
    expect(firstPage[0]).toMatchObject({ id: 'z-random-id', sequence: 1 });
    const secondPage = await store.list({ after: String(firstPage[0]!.sequence), limit: 10 });
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0]).toMatchObject({ id: 'a-random-id', sequence: 2 });
  });

  it('commits matching webhook delivery intent with events and recovers leased retries', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    const endpoint = await createSqliteWebhookStore(db).create({
      url: 'https://example.test/events',
      secret: 'webhook-secret',
      eventTypes: ['invoice.*'],
    });
    const event: RaiFlowEvent = {
      id: 'stable-invoice-event',
      type: 'invoice.completed',
      timestamp: '2026-10-22T00:00:00.000Z',
      data: { invoice: { id: 'invoice-1' } },
      resourceId: 'invoice-1',
      resourceType: 'invoice',
    };
    const events = createSqliteEventStore(db);
    await events.append(event);
    await events.append(event);

    const outbox = createSqliteWebhookOutboxStore(db);
    const firstClaim = await outbox.claimReady(
      'worker-a',
      '2026-10-22T00:00:01.000Z',
      '2026-10-22T00:00:31.000Z',
      10,
    );
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({ event, endpoint, attemptCount: 0 });
    expect(await outbox.claimReady('worker-b', '2026-10-22T00:00:02.000Z', '2026-10-22T00:00:32.000Z', 10))
      .toEqual([]);

    const recoveredClaim = await outbox.claimReady(
      'worker-b',
      '2026-10-22T00:00:31.001Z',
      '2026-10-22T00:01:01.001Z',
      10,
    );
    expect(recoveredClaim).toHaveLength(1);
    expect(await outbox.recordAttempt(firstClaim[0]!.id, 'worker-a', {
      number: 1,
      status: 'delivered',
      responseCode: 200,
      responseBody: 'stale worker result',
      error: null,
      nextRetryAt: null,
      attemptedAt: '2026-10-22T00:00:31.000Z',
    })).toBe(false);
    expect(await outbox.recordAttempt(recoveredClaim[0]!.id, 'worker-b', {
      number: 1,
      status: 'retry',
      responseCode: 503,
      responseBody: 'unavailable',
      error: 'HTTP 503',
      nextRetryAt: '2026-10-22T00:00:35.000Z',
      attemptedAt: '2026-10-22T00:00:31.001Z',
    })).toBe(true);
    expect(await outbox.claimReady('worker-c', '2026-10-22T00:00:34.000Z', '2026-10-22T00:01:04.000Z', 10))
      .toEqual([]);

    const retryClaim = await outbox.claimReady(
      'worker-c',
      '2026-10-22T00:00:35.000Z',
      '2026-10-22T00:01:05.000Z',
      10,
    );
    expect(retryClaim).toHaveLength(1);
    expect(retryClaim[0]?.attemptCount).toBe(1);
    expect(await outbox.recordAttempt(retryClaim[0]!.id, 'worker-c', {
      number: 2,
      status: 'delivered',
      responseCode: 204,
      responseBody: '',
      error: null,
      nextRetryAt: null,
      attemptedAt: '2026-10-22T00:00:35.000Z',
    })).toBe(true);
    expect(await outbox.claimReady('worker-c', '2026-10-22T00:01:00.000Z', '2026-10-22T00:01:30.000Z', 10))
      .toEqual([]);
    expect(db.prepare('SELECT attempt, status, response_code, response_body FROM webhook_deliveries ORDER BY attempt').all())
      .toEqual([
        { attempt: 1, status: 'retry', response_code: 503, response_body: 'unavailable' },
        { attempt: 2, status: 'delivered', response_code: 204, response_body: '' },
      ]);
    expect(await createSqliteWebhookStore(db).delete(endpoint.id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM webhook_outbox').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get()).toEqual({ count: 2 });
  });

  it('allocates a persisted unique target per one-time invoice and reuses explicit references', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    const store = createSqliteInvoiceAccountStore(db);
    const deriveAddress = (index: number) => `nano_${index}`;

    const [first, second] = await Promise.all([
      store.getOrCreate('customer-a', null, 0, 100, deriveAddress),
      store.getOrCreate('customer-a', null, 0, 100, deriveAddress),
    ]);
    const keyed = await store.getOrCreate('customer-a', 'order-1', 0, 100, deriveAddress);
    const keyedReplay = await store.getOrCreate('customer-a', 'order-1', 0, 100, deriveAddress);
    const afterRestart = createSqliteInvoiceAccountStore(db);
    const third = await afterRestart.getOrCreate('customer-b', null, 0, 100, deriveAddress);

    expect([first.derivationIndex, second.derivationIndex, keyed.derivationIndex, third.derivationIndex]).toEqual([0, 1, 2, 3]);
    expect(first.address).not.toBe(second.address);
    expect(keyedReplay).toEqual(keyed);
    expect(third.derivationIndex).toBeGreaterThan(keyed.derivationIndex);
  });

  it('refuses to mutate a pre-v3 database', () => {
    db = createDatabase(':memory:');
    db.exec('CREATE TABLE invoices (id TEXT PRIMARY KEY)');
    expect(() => createMigrationRunner(db!)).toThrow('predates RaiFlow v3');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'").get()).toBeUndefined();
  });

  it('applies invoice lifecycle transitions only from the expected current status', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_transition_recipient');
    const store = createSqliteInvoiceStore(db);

    const expired = await store.transition('invoice-atomic', 'open', { status: 'expired' });
    const canceled = await store.transition('invoice-atomic', 'open', { status: 'canceled' });

    expect(expired?.status).toBe('expired');
    expect(canceled).toBeUndefined();
    expect((await store.get('invoice-atomic'))?.status).toBe('expired');
  });

  it('lists canonical invoices by account key', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_account_one');
    db.prepare("UPDATE invoices SET account_key = 'customer-1' WHERE id = 'invoice-atomic'").run();

    const store = createSqliteInvoiceStore(db);
    expect(await store.listByAccountKey('customer-1')).toMatchObject([
      { id: 'invoice-atomic', accountKey: 'customer-1', payAddress: 'nano_account_one' },
    ]);
    expect(await store.listByAccountKey('unknown')).toEqual([]);
  });

  it('rolls back a failed migration instead of leaving partial tables', async () => {
    db = createDatabase(':memory:');
    db.exec(`
      CREATE TABLE schema_metadata (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO schema_metadata VALUES (1, ${SCHEMA_VERSION}, 'now');
      CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL);
      INSERT INTO migrations VALUES (1, '001_initial_schema', 'now');
      CREATE TABLE invoices (id TEXT PRIMARY KEY);
    `);

    await expect(createMigrationRunner(db).up()).rejects.toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoices_new'").get()).toBeUndefined();
    expect(db.prepare('SELECT id FROM migrations WHERE id = 2').get()).toBeUndefined();
  });

  it('serializes account operations and advances fencing tokens after release or expiry', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    const store = createSqliteAccountOperationLeaseStore(db);
    const now = '2026-10-22T00:00:00.000Z';
    const first = await store.acquire('nano_account', 'owner-a', now, '2026-10-22T00:01:00.000Z');
    expect(first?.fencingToken).toBe(1);
    expect(await store.acquire('nano_account', 'owner-b', now, '2026-10-22T00:01:00.000Z')).toBeUndefined();
    expect(await store.isCurrent(first!, now)).toBe(true);

    await store.release(first!);
    const second = await store.acquire('nano_account', 'owner-b', now, '2026-10-22T00:01:00.000Z');
    expect(second?.fencingToken).toBe(2);
    expect(await store.isCurrent(first!, now)).toBe(false);

    const expired = '2026-10-22T00:02:00.000Z';
    const third = await store.acquire('nano_account', 'owner-c', expired, '2026-10-22T00:03:00.000Z');
    expect(third?.fencingToken).toBe(3);
    expect(await store.renew(second!, expired, '2026-10-22T00:04:00.000Z')).toBe(false);
  });

  it('persists one exact send block intent and only updates its work value', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    db.exec(`
      INSERT INTO accounts (id, type, address, created_at, updated_at)
      VALUES ('account-1', 'managed', 'nano_account', 'now', 'now');
      INSERT INTO sends (
        id, account_id, source_type, source_address, source_derivation_index,
        destination, amount_raw, status, idempotency_key, created_at
      ) VALUES ('send-1', 'account-1', 'account', 'nano_account', NULL,
        'nano_destination', '10', 'queued', 'key-1', 'now');
    `);
    const store = createSqliteSendBlockIntentStore(db);
    const initial = {
      sendId: 'send-1',
      blockHash: 'block-hash-1',
      blockJson: '{"work":"work-a"}',
      frontier: 'frontier-1',
      resultingBalanceRaw: '90',
      createdAt: '2026-10-22T00:00:00.000Z',
    };

    expect(await store.createIfAbsent(initial)).toEqual(initial);
    expect(await store.createIfAbsent({ ...initial, blockHash: 'different-hash' })).toEqual(initial);
    expect(await store.updateWork('send-1', 'different-hash', '{"work":"work-b"}')).toBe(false);
    expect(await store.updateWork('send-1', 'block-hash-1', '{"work":"work-b"}')).toBe(true);
    expect(await store.get('send-1')).toEqual({ ...initial, blockJson: '{"work":"work-b"}' });
  });

  it('stores invoice sourced sends without creating reusable account rows', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_invoice_source');
    const send: Send = {
      id: 'invoice-sweep-1',
      source: { type: 'invoice', invoiceId: 'invoice-atomic', address: 'nano_invoice_source', derivationIndex: 7 },
      destination: 'nano_treasury',
      amountRaw: '100',
      status: 'queued',
      blockHash: null,
      idempotencyKey: 'invoice-sweep:invoice-atomic',
      createdAt: 'now',
      publishedAt: null,
      confirmedAt: null,
    };
    const store = createSqliteSendStore(db);
    await store.create(send);
    expect(await store.get(send.id)).toEqual(send);
    expect(await store.getByIdempotencyKey(send.idempotencyKey)).toEqual(send);
    expect(await store.listByAccount('invoice-atomic')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM accounts WHERE address = 'nano_invoice_source'").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM sends WHERE source_type = 'invoice'").pluck().get()).toBe(1);
  });

  it('migrates queued account sends and exact block intents without losing recovery state', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    db.prepare(`INSERT INTO accounts (id, type, address, derivation_index, created_at, updated_at)
      VALUES ('account-legacy', 'managed', 'nano_legacy_source', 2147483650, 'now', 'now')`).run();

    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE send_block_intents;
      DROP TABLE sends;
      CREATE TABLE sends (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        destination TEXT NOT NULL,
        amount_raw TEXT NOT NULL,
        status TEXT NOT NULL,
        block_hash TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        published_at TEXT,
        confirmed_at TEXT
      );
      CREATE TABLE send_block_intents (
        send_id TEXT PRIMARY KEY REFERENCES sends(id),
        block_hash TEXT NOT NULL,
        block_json TEXT NOT NULL,
        frontier TEXT NOT NULL,
        resulting_balance_raw TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO sends (id, account_id, destination, amount_raw, status, idempotency_key, created_at)
        VALUES ('send-legacy', 'account-legacy', 'nano_destination', '42', 'queued', 'key-legacy', 'now');
      INSERT INTO send_block_intents (send_id, block_hash, block_json, frontier, resulting_balance_raw, created_at)
        VALUES ('send-legacy', 'hash-legacy', '{"work":"saved"}', 'frontier-legacy', '58', 'now');
      DELETE FROM migrations WHERE id = 16;
    `);
    db.pragma('foreign_keys = ON');

    await createMigrationRunner(db).up();

    const send = await createSqliteSendStore(db).get('send-legacy');
    const intent = await createSqliteSendBlockIntentStore(db).get('send-legacy');
    expect(send).toMatchObject({
      id: 'send-legacy',
      source: { type: 'account', accountId: 'account-legacy', address: 'nano_legacy_source', derivationIndex: 2147483650 },
      status: 'queued',
    });
    expect(intent).toMatchObject({
      sendId: 'send-legacy',
      blockHash: 'hash-legacy',
      blockJson: '{"work":"saved"}',
      frontier: 'frontier-legacy',
      resultingBalanceRaw: '58',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('persists one exact receive block intent and only updates its work value', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    db.prepare(`
      INSERT INTO receive_tasks (
        id, account_address, derivation_index, pending_block_hash, amount_raw,
        status, created_at, retry_count
      ) VALUES ('task-1', 'nano_account', 3, 'source-hash', '10', 'processing', 'now', 0)
    `).run();
    const store = createSqliteReceiveBlockIntentStore(db);
    const initial = {
      taskId: 'task-1',
      blockHash: 'receive-hash-1',
      blockJson: '{"work":"work-a"}',
      frontier: 'frontier-1',
      resultingBalanceRaw: '110',
      createdAt: '2026-10-22T00:00:00.000Z',
    };

    expect(await store.createIfAbsent(initial)).toEqual(initial);
    expect(await store.createIfAbsent({ ...initial, blockHash: 'different-hash' })).toEqual(initial);
    expect(await store.updateWork('task-1', 'different-hash', '{"work":"work-b"}')).toBe(false);
    expect(await store.updateWork('task-1', 'receive-hash-1', '{"work":"work-b"}')).toBe(true);
    expect(await store.get('task-1')).toEqual({ ...initial, blockJson: '{"work":"work-b"}' });
  });

  it('stores confirmed deposits by source hash and lists them by recipient account', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    db.prepare(`
      INSERT INTO invoices (
        id, status, pay_address, expected_amount_raw, received_amount_raw,
        created_at, updated_at, completion_policy
      ) VALUES ('invoice-1', 'open', 'nano_recipient_a', '10', '0', 'now', 'now', '{"type":"at_least"}')
    `).run();
    const store = createSqliteDepositStore(db);
    const deposit = {
      id: 'deposit-1',
      blockHash: 'source-hash-1',
      recipientAccount: 'nano_recipient_a',
      senderAccount: 'nano_sender',
      amountRaw: '10',
      invoiceId: null,
      disposition: 'unmatched' as const,
      confirmedAt: '2026-10-22T00:00:00.000Z',
    };

    expect(await store.createIfAbsent(deposit)).toEqual(deposit);
    expect(await store.createIfAbsent({ ...deposit, amountRaw: '999', invoiceId: 'invoice-1' })).toEqual({
      ...deposit,
      invoiceId: 'invoice-1',
      disposition: 'unmatched',
    });
    expect(await store.getByBlockHash(deposit.blockHash)).toMatchObject({ id: 'deposit-1', invoiceId: 'invoice-1' });
    expect(await store.get?.('deposit-1')).toMatchObject({ blockHash: deposit.blockHash });
    expect(await store.listByRecipientAccounts(['nano_recipient_a'])).toHaveLength(1);
    expect(await store.listByRecipientAccounts([])).toEqual([]);
  });

  it('atomically queues linked refunds, preserves idempotent replay, and caps refunds at the deposit amount', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_refund_source', '1000000000000000000000000000000');
    const deposit = await createSqliteDepositStore(db).createIfAbsent({
      id: 'deposit-refund', blockHash: 'refund-source-hash', recipientAccount: 'nano_refund_source',
      senderAccount: 'nano_exchange_hot_wallet', amountRaw: '1000000000000000000000000000000',
      invoiceId: 'invoice-atomic', disposition: 'matched', confirmedAt: '2026-10-22T00:00:00.000Z',
    });
    const store = createSqliteRefundStore(db);
    const createPair = (amountRaw: string, idempotencyKey: string, suffix: string) => {
      const send: Send = {
        id: `send-${suffix}`, source: { type: 'invoice', invoiceId: 'invoice-atomic', address: 'nano_refund_source', derivationIndex: 7 },
        destination: 'nano_verified_destination', amountRaw, status: 'queued', blockHash: null,
        idempotencyKey: `refund:${deposit.id}:${idempotencyKey}`, createdAt: '2026-10-22T00:01:00.000Z',
        publishedAt: null, confirmedAt: null,
      };
      const refund: Refund = {
        id: `refund-${suffix}`, depositId: deposit.id, invoiceId: deposit.invoiceId, sendId: send.id,
        destination: send.destination, amountRaw, status: 'queued', idempotencyKey,
        createdAt: send.createdAt, publishedAt: null, confirmedAt: null,
      };
      return { send, refund };
    };

    const first = createPair('600000000000000000000000000000', 'order-refund-1', 'one');
    const queued = await store.queue(deposit, first.refund, first.send);
    expect(queued.created).toBe(true);
    expect(queued.refund.status).toBe('queued');

    const replayPair = createPair(first.refund.amountRaw, first.refund.idempotencyKey, 'replay');
    const replay = await store.queue(deposit, replayPair.refund, replayPair.send);
    expect(replay.created).toBe(false);
    expect(replay.refund.id).toBe(first.refund.id);

    const overLimit = createPair('500000000000000000000000000000', 'order-refund-2', 'two');
    await expect(store.queue(deposit, overLimit.refund, overLimit.send))
      .rejects.toThrow('Refund amount exceeds the unrefunded deposit amount');
    expect(await store.listByDepositId(deposit.id)).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM sends').get()).toEqual({ count: 1 });

    const conflictingReplay = createPair('1', first.refund.idempotencyKey, 'conflict');
    await expect(store.queue(deposit, conflictingReplay.refund, conflictingReplay.send))
      .rejects.toThrow('Refund idempotency key was reused with different parameters');
  });

  it('persists one account-history recovery cursor per watched address', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    const store = createSqliteAccountHistoryRecoveryCursorStore(db);

    expect(await store.get('nano_account')).toBeUndefined();
    await store.set('nano_account', 'head-1');
    expect(await store.get('nano_account')).toBe('head-1');
    await store.set('nano_account', 'head-2');
    expect(await store.get('nano_account')).toBe('head-2');
    expect(db.prepare('SELECT COUNT(*) AS count FROM account_history_recovery_cursors').get())
      .toEqual({ count: 1 });
  });

  it('atomically records a deposit, invoice payment, lifecycle events, and receive task intent', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_atomic_recipient');
    await createSqliteWebhookStore(db).create({
      url: 'https://example.test/all',
      secret: 'webhook-secret',
      eventTypes: ['*'],
    });
    const block = {
      blockHash: 'atomic-source-hash',
      senderAccount: 'nano_sender',
      recipientAccount: 'nano_atomic_recipient',
      amountRaw: '100',
      confirmedAt: '2026-10-22T00:01:00.000Z',
    };
    const store = createSqliteConfirmedDepositIngestStore(db);

    const [result, restartedResult] = await Promise.all([
      store.ingest(block),
      createSqliteConfirmedDepositIngestStore(db).ingest(block),
    ]);

    expect(result.created).toBe(true);
    expect(result.deposit).toMatchObject({ blockHash: block.blockHash, invoiceId: 'invoice-atomic' });
    expect(result.deposit.disposition).toBe('matched');
    expect(result.payment).toMatchObject({ invoiceId: 'invoice-atomic', amountRaw: '100' });
    expect(result.events.map((event) => event.type)).toEqual([
      'deposit.observed',
      'invoice.payment_received',
      'invoice.payment_confirmed',
      'invoice.completed',
    ]);
    expect(restartedResult.created).toBe(false);
    expect(restartedResult.events).toEqual([]);
    expect(db.prepare('SELECT received_amount_raw, status FROM invoices WHERE id = ?').get('invoice-atomic'))
      .toEqual({ received_amount_raw: '100', status: 'completed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM deposits').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM payments').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM events WHERE type = ?').get('invoice.completed'))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM webhook_outbox').get()).toEqual({ count: 4 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM receive_tasks WHERE pending_block_hash = ?').get(block.blockHash))
      .toEqual({ count: 1 });
  });

  it('pauses new deposits at the per-account limit while preserving replay and existing evidence', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    const store = createSqliteConfirmedDepositIngestStore(db, {
      maxDatabaseBytes: 1024 * 1024 * 1024,
      maxDepositsPerAccount: 1,
    });
    const firstBlock = {
      blockHash: 'budget-first-hash',
      senderAccount: 'nano_sender',
      recipientAccount: 'nano_budget_recipient',
      amountRaw: '1',
      confirmedAt: '2026-10-23T00:01:00.000Z',
    };
    await store.ingest(firstBlock);

    expect(store.getStorageBudgetStatus?.()).toMatchObject({
      globallyPaused: false,
      pausedAccountCount: 1,
    });
    await expect(store.ingest({ ...firstBlock, blockHash: 'budget-second-hash' }))
      .rejects.toBeInstanceOf(StorageBudgetExceededError);
    const replay = await store.ingest(firstBlock);

    expect(replay.created).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM deposits').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM receive_tasks').get()).toEqual({ count: 0 });
  });

  it('pauses global inbound ingestion before the configured database budget', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    db.prepare(`
      INSERT INTO events (id, type, timestamp, resource_id, resource_type, data)
      VALUES ('large-event', 'operator.note', 'now', 'large-event', 'event', ?)
    `).run(JSON.stringify({ payload: 'x'.repeat(900_000) }));
    const store = createSqliteConfirmedDepositIngestStore(db, {
      maxDatabaseBytes: 1024 * 1024,
      maxDepositsPerAccount: 100,
    });
    const status = store.getStorageBudgetStatus?.();

    expect(status?.globallyPaused).toBe(true);
    await expect(store.ingest({
      blockHash: 'global-budget-hash',
      senderAccount: 'nano_sender',
      recipientAccount: 'nano_budget_recipient',
      amountRaw: '1',
      confirmedAt: '2026-10-23T00:01:00.000Z',
    })).rejects.toMatchObject({ reason: 'global' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM deposits').get()).toEqual({ count: 0 });
  });

  it('repairs a prior partial payment write during source-hash replay', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_atomic_recipient');
    db.exec(`
      INSERT INTO deposits (block_hash, id, recipient_account, sender_account, amount_raw, invoice_id, confirmed_at)
      VALUES ('partial-source-hash', 'deposit-partial', 'nano_atomic_recipient', 'nano_sender', '100', 'invoice-atomic', '2026-10-22T00:01:00.000Z');
      INSERT INTO payments (id, invoice_id, status, block_hash, sender_address, amount_raw, confirmed_at, detected_at)
      VALUES ('payment-partial', 'invoice-atomic', 'confirmed', 'partial-source-hash', 'nano_sender', '100', '2026-10-22T00:01:00.000Z', '2026-10-22T00:01:00.000Z');
    `);

    const result = await createSqliteConfirmedDepositIngestStore(db).ingest({
      blockHash: 'partial-source-hash',
      senderAccount: 'nano_sender',
      recipientAccount: 'nano_atomic_recipient',
      amountRaw: '100',
      confirmedAt: '2026-10-22T00:01:00.000Z',
    });

    expect(result.created).toBe(false);
    expect(result.payment?.id).toBe('payment-partial');
    expect(result.events.map((event) => event.type)).toContain('invoice.completed');
    expect(db.prepare('SELECT received_amount_raw, status FROM invoices WHERE id = ?').get('invoice-atomic'))
      .toEqual({ received_amount_raw: '100', status: 'completed' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM payments').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM events WHERE type = ?').get('invoice.completed'))
      .toEqual({ count: 1 });
  });

  it('classifies partial, excess, late, and unmatched confirmed deposits without paying a newer invoice', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_disposition_recipient', '100');
    db.prepare(`
      INSERT INTO invoices (
        id, status, pay_address, expected_amount_raw, received_amount_raw,
        created_at, updated_at, completion_policy
      ) VALUES ('invoice-newer', 'open', 'nano_disposition_recipient', '50', '0', 'later', 'later', '{"type":"at_least"}')
    `).run();
    const store = createSqliteConfirmedDepositIngestStore(db);

    const partial = await store.ingest({
      blockHash: 'disposition-partial', senderAccount: 'nano_sender',
      recipientAccount: 'nano_disposition_recipient', amountRaw: '30',
      confirmedAt: '2026-10-22T00:01:00.000Z',
    });
    const excess = await store.ingest({
      blockHash: 'disposition-excess', senderAccount: 'nano_sender',
      recipientAccount: 'nano_disposition_recipient', amountRaw: '80',
      confirmedAt: '2026-10-22T00:02:00.000Z',
    });
    const late = await store.ingest({
      blockHash: 'disposition-late', senderAccount: 'nano_sender',
      recipientAccount: 'nano_disposition_recipient', amountRaw: '5',
      confirmedAt: '2026-10-22T00:03:00.000Z',
    });
    const unmatched = await store.ingest({
      blockHash: 'disposition-unmatched', senderAccount: 'nano_sender',
      recipientAccount: 'nano_unknown_recipient', amountRaw: '5',
      confirmedAt: '2026-10-22T00:04:00.000Z',
    });

    expect(partial.deposit).toMatchObject({ invoiceId: 'invoice-atomic', disposition: 'partial' });
    expect(excess.deposit).toMatchObject({ invoiceId: 'invoice-atomic', disposition: 'excess' });
    expect(late.deposit).toMatchObject({ invoiceId: 'invoice-atomic', disposition: 'late' });
    expect(late.payment).toBeUndefined();
    expect(unmatched.deposit).toMatchObject({ invoiceId: null, disposition: 'unmatched' });
    expect(db.prepare('SELECT received_amount_raw, status FROM invoices WHERE id = ?').get('invoice-atomic'))
      .toEqual({ received_amount_raw: '110', status: 'completed' });
    expect(db.prepare('SELECT received_amount_raw, status FROM invoices WHERE id = ?').get('invoice-newer'))
      .toEqual({ received_amount_raw: '0', status: 'open' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM payments').get()).toEqual({ count: 2 });
  });

  it('does not enqueue a receive task for an inbound send found already received in account history', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_atomic_recipient');

    await createSqliteConfirmedDepositIngestStore(db).ingest({
      blockHash: 'already-received-source',
      senderAccount: 'nano_sender',
      recipientAccount: 'nano_atomic_recipient',
      amountRaw: '10',
      confirmedAt: '2026-10-22T00:01:00.000Z',
      alreadyReceived: true,
    });

    expect(db.prepare('SELECT COUNT(*) AS count FROM receive_tasks').get()).toEqual({ count: 0 });
  });

  it('rolls back the whole confirmed-deposit transition when event persistence fails', async () => {
    db = createDatabase(':memory:');
    await createMigrationRunner(db).up();
    await seedInvoice('nano_atomic_recipient');
    await createSqliteWebhookStore(db).create({
      url: 'https://example.test/all',
      secret: 'webhook-secret',
      eventTypes: ['*'],
    });
    db.exec(`
      CREATE TRIGGER fail_payment_event BEFORE INSERT ON events
      WHEN NEW.type = 'invoice.payment_confirmed'
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;
    `);
    const store = createSqliteConfirmedDepositIngestStore(db);

    await expect(store.ingest({
      blockHash: 'rollback-source-hash',
      senderAccount: 'nano_sender',
      recipientAccount: 'nano_atomic_recipient',
      amountRaw: '100',
      confirmedAt: '2026-10-22T00:01:00.000Z',
    })).rejects.toThrow('injected event failure');

    expect(db.prepare('SELECT COUNT(*) AS count FROM deposits').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM payments').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM webhook_outbox').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM receive_tasks').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT received_amount_raw, status FROM invoices WHERE id = ?').get('invoice-atomic'))
      .toEqual({ received_amount_raw: '0', status: 'open' });
  });
});
