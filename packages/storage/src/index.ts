// @openrai/storage — Persistent data access layer

import type {
  Invoice,
  InvoiceAccount,
  InvoiceAccountStore,
  InvoiceStore,
  InvoiceStatus,
  Payment,
  PaymentStore,
  PaymentStatus,
  Deposit,
  DepositStore,
  Refund,
  RefundStore,
  RefundQueueResult,
  ConfirmedBlock,
  ReceiveTask,
  Account,
  AccountStore,
  AccountType,
  Send,
  SendStore,
  SendStatus,
  ReceiveTaskStatus,
  ReceiveTaskStore,
  EventStore,
  RaiFlowEvent,
  WebhookEndpoint,
  WebhookEndpointStore,
  EventQueryOptions,
  IdempotencyReplayStore,
  IdempotencyRecord,
} from '@openrai/model';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

export interface StorageConfig {
  driver: 'sqlite';
  path: string;
  maxDatabaseBytes: number;
  maxDepositsPerAccount: number;
}

export interface ConfirmedDepositIngestResult {
  deposit: Deposit;
  payment?: Payment;
  created: boolean;
  events: RaiFlowEvent[];
}

/** Atomic durable boundary for confirmed inbound sends and invoice effects. */
export interface ConfirmedDepositIngestStore {
  ingest(block: ConfirmedBlock): Promise<ConfirmedDepositIngestResult>;
  getStorageBudgetStatus?(): StorageBudgetStatus;
}

export interface StorageBudgetStatus {
  databaseBytes: number;
  maxDatabaseBytes: number;
  remainingBytes: number;
  globallyPaused: boolean;
  pausedAccountCount: number;
}

export class StorageBudgetExceededError extends Error {
  readonly code = 'storage_budget_exceeded';

  constructor(readonly reason: 'global' | 'account') {
    super(reason === 'global'
      ? 'Inbound processing is paused because the SQLite storage budget is nearly full'
      : 'Inbound processing is paused because this account reached its deposit storage budget');
    this.name = 'StorageBudgetExceededError';
  }
}

export interface ConfirmedDepositIngestOptions {
  maxDatabaseBytes: number;
  maxDepositsPerAccount: number;
}

/** Internal persistence contract for per-address account-chain write leases. */
export interface AccountOperationLease {
  accountAddress: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
}

export interface AccountOperationLeaseStore {
  acquire(accountAddress: string, ownerId: string, now: string, expiresAt: string): Promise<AccountOperationLease | undefined>;
  renew(lease: AccountOperationLease, now: string, expiresAt: string): Promise<boolean>;
  isCurrent(lease: AccountOperationLease, now: string): Promise<boolean>;
  release(lease: AccountOperationLease): Promise<void>;
}

/** Internal durable representation of a signed send before network broadcast. */
export interface SendBlockIntent {
  sendId: string;
  blockHash: string;
  blockJson: string;
  frontier: string;
  resultingBalanceRaw: string;
  createdAt: string;
}

export interface SendBlockIntentStore {
  get(sendId: string): Promise<SendBlockIntent | undefined>;
  /** Insert once; return the stored intent if another attempt already won. */
  createIfAbsent(intent: SendBlockIntent): Promise<SendBlockIntent>;
  updateWork(sendId: string, blockHash: string, blockJson: string): Promise<boolean>;
}

/** Internal durable representation of a receive block before network broadcast. */
export interface ReceiveBlockIntent {
  taskId: string;
  blockHash: string;
  blockJson: string;
  frontier: string;
  resultingBalanceRaw: string;
  createdAt: string;
}

export interface ReceiveBlockIntentStore {
  get(taskId: string): Promise<ReceiveBlockIntent | undefined>;
  createIfAbsent(intent: ReceiveBlockIntent): Promise<ReceiveBlockIntent>;
  updateWork(taskId: string, blockHash: string, blockJson: string): Promise<boolean>;
}

export interface Migration {
  id: number;
  name: string;
  up(db: Database): void;
}

export interface MigrationRunner {
  up(): Promise<void>;
  getApplied(): string[];
}

export const SCHEMA_VERSION = 3;

export function createDatabase(path: string, options?: { maxDatabaseBytes?: number }): Database {
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  if (options?.maxDatabaseBytes !== undefined) {
    const pageSize = Number(db.pragma('page_size', { simple: true }));
    const walLimitBytes = Math.min(16 * 1024 * 1024, Math.floor(options.maxDatabaseBytes / 8));
    const maxPages = Math.floor((options.maxDatabaseBytes - walLimitBytes) / pageSize);
    db.pragma(`max_page_count = ${maxPages}`);
    db.pragma(`journal_size_limit = ${walLimitBytes}`);
    db.pragma('wal_autocheckpoint = 256');
  }
  return db;
}

export function createMigrationRunner(db: Database): MigrationRunner {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string }>;
  const hasSchemaMetadata = tables.some((table) => table.name === 'schema_metadata');
  if (tables.length > 0 && !hasSchemaMetadata) {
    throw new Error(
      'This database predates RaiFlow v3 and cannot be upgraded in place. Start with a new v3 database.',
    );
  }
  if (hasSchemaMetadata) {
    const row = db.prepare('SELECT version FROM schema_metadata WHERE id = 1').get() as { version: number } | undefined;
    if (!row || row.version !== SCHEMA_VERSION) {
      throw new Error(`Unsupported RaiFlow schema version: ${row?.version ?? 'missing'}; expected ${SCHEMA_VERSION}`);
    }
  } else {
    db.exec(`
      CREATE TABLE schema_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO schema_metadata (id, version, created_at) VALUES (1, ?, ?)')
      .run(SCHEMA_VERSION, new Date().toISOString());
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const migrations: Migration[] = [
    {
      id: 1,
      name: '001_initial_schema',
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS invoices (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            pay_address TEXT NOT NULL,
            expected_amount_raw TEXT NOT NULL,
            received_amount_raw TEXT NOT NULL DEFAULT '0',
            memo TEXT,
            metadata TEXT,
            idempotency_key TEXT UNIQUE,
            expires_at TEXT,
            completed_at TEXT,
            canceled_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completion_policy TEXT NOT NULL DEFAULT '{"type":"at_least"}'
          );

          CREATE TABLE IF NOT EXISTS payments (
            id TEXT PRIMARY KEY,
            invoice_id TEXT NOT NULL REFERENCES invoices(id),
            status TEXT NOT NULL,
            block_hash TEXT NOT NULL UNIQUE,
            sender_address TEXT,
            amount_raw TEXT NOT NULL,
            confirmed_at TEXT,
            detected_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            account_key TEXT UNIQUE,
            type TEXT NOT NULL,
            address TEXT NOT NULL UNIQUE,
            label TEXT,
            balance_raw TEXT NOT NULL DEFAULT '0',
            pending_raw TEXT NOT NULL DEFAULT '0',
            frontier TEXT,
            representative TEXT,
            derivation_index INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS sends (
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

          CREATE TABLE IF NOT EXISTS events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            data TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS webhooks (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            secret TEXT NOT NULL,
            event_types TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id TEXT PRIMARY KEY,
            webhook_id TEXT NOT NULL REFERENCES webhooks(id),
            event_id TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            response_code INTEGER,
            response_body TEXT,
            next_retry_at TEXT,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS idempotency_keys (
            key TEXT PRIMARY KEY,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS account_frontiers (
            account_id TEXT PRIMARY KEY REFERENCES accounts(id),
            frontier TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS published_blocks (
            block_hash TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            published_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS pending_receivables (
            account_id TEXT NOT NULL REFERENCES accounts(id),
            block_hash TEXT NOT NULL,
            amount_raw TEXT NOT NULL,
            source_account TEXT,
            detected_at TEXT NOT NULL,
            received_at TEXT,
            PRIMARY KEY (account_id, block_hash)
          );

          CREATE INDEX IF NOT EXISTS idx_events_resource ON events(resource_type, resource_id, sequence);
          CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, sequence);
          CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
          CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id, id);
          CREATE INDEX IF NOT EXISTS idx_payments_block_hash ON payments(block_hash);
          CREATE INDEX IF NOT EXISTS idx_sends_account ON sends(account_id, id);
          CREATE INDEX IF NOT EXISTS idx_sends_idempotency ON sends(idempotency_key);
          CREATE INDEX IF NOT EXISTS idx_invoices_pay_address ON invoices(pay_address);
          CREATE INDEX IF NOT EXISTS idx_invoices_idempotency ON invoices(idempotency_key);
          CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
          CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event ON webhook_deliveries(event_id);
          CREATE INDEX IF NOT EXISTS idx_pending_receivables_account ON pending_receivables(account_id, received_at);
        `);
      },
    },
    {
      id: 2,
      name: '002_allow_duplicate_invoice_pay_addresses',
      up: (db) => {
        db.exec(`
          DROP INDEX IF EXISTS idx_invoices_pay_address;

          CREATE TABLE invoices_new (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            pay_address TEXT NOT NULL,
            expected_amount_raw TEXT NOT NULL,
            received_amount_raw TEXT NOT NULL DEFAULT '0',
            memo TEXT,
            metadata TEXT,
            idempotency_key TEXT UNIQUE,
            expires_at TEXT,
            completed_at TEXT,
            canceled_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completion_policy TEXT NOT NULL DEFAULT '{"type":"at_least"}'
          );

          INSERT INTO invoices_new (
            id, status, pay_address, expected_amount_raw, received_amount_raw,
            memo, metadata, idempotency_key, expires_at, completed_at, canceled_at,
            created_at, updated_at, completion_policy
          )
          SELECT
            id, status, pay_address, expected_amount_raw, received_amount_raw,
            memo, metadata, idempotency_key, expires_at, completed_at, canceled_at,
            created_at, updated_at, completion_policy
          FROM invoices;

          DROP TABLE invoices;
          ALTER TABLE invoices_new RENAME TO invoices;

          CREATE INDEX IF NOT EXISTS idx_invoices_pay_address ON invoices(pay_address);
          CREATE INDEX IF NOT EXISTS idx_invoices_idempotency ON invoices(idempotency_key);
          CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
        `);
      },
    },
    {
      id: 3,
      name: '003_invoice_derivation_index',
      up: (db) => {
        db.exec(`
          ALTER TABLE invoices ADD COLUMN derivation_index INTEGER;
        `);
      },
    },
    {
      id: 4,
      name: '004_invoice_accounts',
      up: (db) => {
        db.exec(`
          CREATE TABLE invoice_accounts (
            account_key TEXT NOT NULL,
            invoice_key TEXT,
            derivation_index INTEGER NOT NULL UNIQUE,
            address TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (account_key, invoice_key)
          );
        `);
      },
    },
    {
      id: 5,
      name: '005_receive_tasks',
      up: (db) => {
        db.exec(`
          CREATE TABLE receive_tasks (
            id TEXT PRIMARY KEY,
            account_address TEXT NOT NULL,
            derivation_index INTEGER NOT NULL,
            pending_block_hash TEXT NOT NULL UNIQUE,
            amount_raw TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL,
            published_at TEXT,
            confirmed_at TEXT,
            failed_at TEXT,
            fail_reason TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0
          );
        `);
      },
    },
    {
      id: 6,
      name: '006_invoices_account_invoice_keys',
      up: (db) => {
        db.exec(`
          ALTER TABLE invoices ADD COLUMN account_key TEXT NOT NULL DEFAULT '';
        `);
        db.exec(`
          ALTER TABLE invoices ADD COLUMN invoice_key TEXT;
        `);
      },
    },
    {
      id: 7,
      name: '007_invoice_compound_lookup_index',
      up: (db) => {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_invoices_account_invoice
            ON invoices(account_key, invoice_key);
        `);
      },
    },
    {
      id: 8,
      name: '008_receive_block_hash',
      up: (db) => {
        db.exec(`ALTER TABLE receive_tasks ADD COLUMN receive_block_hash TEXT`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_receive_tasks_receive_block_hash ON receive_tasks(receive_block_hash)`);
      },
    },
    {
      id: 9,
      name: '009_account_operation_leases',
      up: (db) => {
        db.exec(`
          CREATE TABLE account_operation_leases (
            account_address TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            fencing_token INTEGER NOT NULL,
            expires_at TEXT NOT NULL
          );
        `);
      },
    },
    {
      id: 10,
      name: '010_send_block_intents',
      up: (db) => {
        db.exec(`
          CREATE TABLE send_block_intents (
            send_id TEXT PRIMARY KEY REFERENCES sends(id),
            block_hash TEXT NOT NULL,
            block_json TEXT NOT NULL,
            frontier TEXT NOT NULL,
            resulting_balance_raw TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
      },
    },
    {
      id: 11,
      name: '011_receive_block_intents',
      up: (db) => {
        db.exec(`
          CREATE TABLE receive_block_intents (
            task_id TEXT PRIMARY KEY REFERENCES receive_tasks(id),
            block_hash TEXT NOT NULL,
            block_json TEXT NOT NULL,
            frontier TEXT NOT NULL,
            resulting_balance_raw TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `);
      },
    },
    {
      id: 12,
      name: '012_confirmed_deposits',
      up: (db) => {
        db.exec(`
          CREATE TABLE deposits (
            block_hash TEXT PRIMARY KEY,
            id TEXT NOT NULL UNIQUE,
            recipient_account TEXT NOT NULL,
            sender_account TEXT,
            amount_raw TEXT NOT NULL,
            invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
            confirmed_at TEXT NOT NULL
          );
          CREATE INDEX idx_deposits_recipient_confirmed
            ON deposits(recipient_account, confirmed_at DESC);
          CREATE INDEX idx_deposits_invoice ON deposits(invoice_id, confirmed_at DESC);
        `);
      },
    },
    {
      id: 13,
      name: '013_account_history_recovery_cursors',
      up: (db) => {
        db.exec(`
          CREATE TABLE account_history_recovery_cursors (
            account_address TEXT PRIMARY KEY,
            block_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
      },
    },
    {
      id: 14,
      name: '014_invoice_account_reference_index',
      up: (db) => {
        db.exec(`
          CREATE UNIQUE INDEX idx_invoice_accounts_reference
            ON invoice_accounts(account_key, invoice_key)
            WHERE invoice_key IS NOT NULL;
        `);
      },
    },
    {
      id: 15,
      name: '015_deposit_dispositions',
      up: (db) => {
        db.exec(`
          ALTER TABLE deposits ADD COLUMN disposition TEXT NOT NULL DEFAULT 'matched';
          UPDATE deposits SET disposition = 'unmatched' WHERE invoice_id IS NULL;
        `);
      },
    },
    {
      id: 16,
      name: '016_send_sources',
      up: (db) => {
        db.exec(`
          ALTER TABLE send_block_intents RENAME TO send_block_intents_legacy;
          ALTER TABLE sends RENAME TO sends_legacy;

          CREATE TABLE sends (
            id TEXT PRIMARY KEY,
            account_id TEXT REFERENCES accounts(id),
            source_type TEXT NOT NULL,
            source_address TEXT NOT NULL,
            source_derivation_index INTEGER,
            source_invoice_id TEXT REFERENCES invoices(id),
            destination TEXT NOT NULL,
            amount_raw TEXT NOT NULL,
            status TEXT NOT NULL,
            block_hash TEXT,
            idempotency_key TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            published_at TEXT,
            confirmed_at TEXT,
            CHECK (
              (source_type = 'account' AND account_id IS NOT NULL AND source_invoice_id IS NULL)
              OR (source_type = 'invoice' AND account_id IS NULL AND source_invoice_id IS NOT NULL AND source_derivation_index IS NOT NULL)
            )
          );
          INSERT INTO sends (
            id, account_id, source_type, source_address, source_derivation_index,
            source_invoice_id, destination, amount_raw, status, block_hash,
            idempotency_key, created_at, published_at, confirmed_at
          )
          SELECT s.id, s.account_id, 'account', a.address, a.derivation_index,
            NULL, s.destination, s.amount_raw, s.status, s.block_hash,
            s.idempotency_key, s.created_at, s.published_at, s.confirmed_at
          FROM sends_legacy AS s JOIN accounts AS a ON a.id = s.account_id;

          CREATE TABLE send_block_intents (
            send_id TEXT PRIMARY KEY REFERENCES sends(id),
            block_hash TEXT NOT NULL,
            block_json TEXT NOT NULL,
            frontier TEXT NOT NULL,
            resulting_balance_raw TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO send_block_intents SELECT * FROM send_block_intents_legacy;
          DROP TABLE send_block_intents_legacy;
          DROP TABLE sends_legacy;
          CREATE INDEX idx_sends_account ON sends(account_id, id);
          CREATE INDEX idx_sends_idempotency ON sends(idempotency_key);
          CREATE INDEX idx_sends_invoice ON sends(source_invoice_id, id);
        `);
      },
    },
    {
      id: 17,
      name: '017_webhook_outbox',
      up: (db) => {
        db.exec(`
          CREATE TABLE webhook_outbox (
            id TEXT PRIMARY KEY,
            event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
            webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT NOT NULL,
            lease_owner TEXT,
            lease_until TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (event_id, webhook_id)
          );
          CREATE INDEX idx_webhook_outbox_ready
            ON webhook_outbox(status, next_attempt_at, lease_until, created_at);
          CREATE INDEX idx_webhook_outbox_webhook
            ON webhook_outbox(webhook_id, created_at);
        `);
      },
    },
    {
      id: 18,
      name: '018_webhook_attempt_history',
      up: (db) => {
        db.exec(`
          ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_legacy;
          CREATE TABLE webhook_deliveries (
            id TEXT PRIMARY KEY,
            webhook_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            attempt INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            response_code INTEGER,
            response_body TEXT,
            next_retry_at TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO webhook_deliveries SELECT * FROM webhook_deliveries_legacy;
          DROP TABLE webhook_deliveries_legacy;
          CREATE INDEX idx_webhook_deliveries_event ON webhook_deliveries(event_id);
          CREATE INDEX idx_webhook_deliveries_target ON webhook_deliveries(webhook_id, event_id, attempt);
        `);
      },
    },
    {
      id: 19,
      name: '019_deposit_refunds',
      up: (db) => {
        db.exec(`
          CREATE TABLE refunds (
            id TEXT PRIMARY KEY,
            deposit_id TEXT NOT NULL REFERENCES deposits(id) ON DELETE RESTRICT,
            invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
            send_id TEXT NOT NULL UNIQUE REFERENCES sends(id) ON DELETE RESTRICT,
            destination TEXT NOT NULL,
            amount_raw TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (deposit_id, idempotency_key)
          );
          CREATE INDEX idx_refunds_deposit ON refunds(deposit_id, created_at, id);
        `);
      },
    },
  ];

  return {
    async up(): Promise<void> {
      for (const m of migrations) {
        const row = db.prepare('SELECT id FROM migrations WHERE id = ?').get(m.id);
        if (!row) {
          db.transaction(() => {
            m.up(db);
            db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
              m.id,
              m.name,
              new Date().toISOString(),
            );
          })();
        }
      }
    },
    getApplied(): string[] {
      const rows = db.prepare('SELECT name FROM migrations ORDER BY id').all() as { name: string }[];
      return rows.map((r) => r.name);
    },
  };
}

/** Persisted account-chain ownership with monotonically increasing fencing tokens. */
export function createSqliteAccountOperationLeaseStore(db: Database): AccountOperationLeaseStore {
  const acquire = db.transaction((accountAddress: string, ownerId: string, now: string, expiresAt: string) => {
    const result = db.prepare(`
      INSERT INTO account_operation_leases (account_address, owner_id, fencing_token, expires_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(account_address) DO UPDATE SET
        owner_id = excluded.owner_id,
        fencing_token = account_operation_leases.fencing_token + 1,
        expires_at = excluded.expires_at
      WHERE account_operation_leases.expires_at <= ?
    `).run(accountAddress, ownerId, expiresAt, now);
    if (result.changes === 0) return undefined;
    const row = db.prepare(`
      SELECT account_address, owner_id, fencing_token, expires_at
      FROM account_operation_leases WHERE account_address = ?
    `).get(accountAddress) as Record<string, unknown>;
    return rowToAccountOperationLease(row);
  });

  return {
    async acquire(accountAddress, ownerId, now, expiresAt) {
      return acquire(accountAddress, ownerId, now, expiresAt);
    },
    async renew(lease, now, expiresAt) {
      const result = db.prepare(`
        UPDATE account_operation_leases SET expires_at = ?
        WHERE account_address = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
      `).run(expiresAt, lease.accountAddress, lease.ownerId, lease.fencingToken, now);
      return result.changes === 1;
    },
    async isCurrent(lease, now) {
      return Boolean(db.prepare(`
        SELECT 1 FROM account_operation_leases
        WHERE account_address = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?
      `).get(lease.accountAddress, lease.ownerId, lease.fencingToken, now));
    },
    async release(lease) {
      db.prepare(`
        UPDATE account_operation_leases SET expires_at = '1970-01-01T00:00:00.000Z'
        WHERE account_address = ? AND owner_id = ? AND fencing_token = ?
      `).run(lease.accountAddress, lease.ownerId, lease.fencingToken);
    },
  };
}

export function createSqliteSendBlockIntentStore(db: Database): SendBlockIntentStore {
  const insert = db.transaction((intent: SendBlockIntent): SendBlockIntent => {
    db.prepare(`
      INSERT INTO send_block_intents (send_id, block_hash, block_json, frontier, resulting_balance_raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(send_id) DO NOTHING
    `).run(intent.sendId, intent.blockHash, intent.blockJson, intent.frontier, intent.resultingBalanceRaw, intent.createdAt);
    const row = db.prepare('SELECT * FROM send_block_intents WHERE send_id = ?').get(intent.sendId) as Record<string, unknown>;
    return rowToSendBlockIntent(row);
  });

  return {
    async get(sendId) {
      const row = db.prepare('SELECT * FROM send_block_intents WHERE send_id = ?').get(sendId) as Record<string, unknown> | undefined;
      return row ? rowToSendBlockIntent(row) : undefined;
    },
    async createIfAbsent(intent) {
      return insert(intent);
    },
    async updateWork(sendId, blockHash, blockJson) {
      const result = db.prepare(`
        UPDATE send_block_intents SET block_json = ?
        WHERE send_id = ? AND block_hash = ?
      `).run(blockJson, sendId, blockHash);
      return result.changes === 1;
    },
  };
}

function rowToSendBlockIntent(row: Record<string, unknown>): SendBlockIntent {
  return {
    sendId: row.send_id as string,
    blockHash: row.block_hash as string,
    blockJson: row.block_json as string,
    frontier: row.frontier as string,
    resultingBalanceRaw: row.resulting_balance_raw as string,
    createdAt: row.created_at as string,
  };
}

export function createSqliteReceiveBlockIntentStore(db: Database): ReceiveBlockIntentStore {
  const insert = db.transaction((intent: ReceiveBlockIntent): ReceiveBlockIntent => {
    db.prepare(`
      INSERT INTO receive_block_intents (task_id, block_hash, block_json, frontier, resulting_balance_raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(intent.taskId, intent.blockHash, intent.blockJson, intent.frontier, intent.resultingBalanceRaw, intent.createdAt);
    const row = db.prepare('SELECT * FROM receive_block_intents WHERE task_id = ?').get(intent.taskId) as Record<string, unknown>;
    return rowToReceiveBlockIntent(row);
  });

  return {
    async get(taskId) {
      const row = db.prepare('SELECT * FROM receive_block_intents WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;
      return row ? rowToReceiveBlockIntent(row) : undefined;
    },
    async createIfAbsent(intent) {
      return insert(intent);
    },
    async updateWork(taskId, blockHash, blockJson) {
      const result = db.prepare(`
        UPDATE receive_block_intents SET block_json = ?
        WHERE task_id = ? AND block_hash = ?
      `).run(blockJson, taskId, blockHash);
      return result.changes === 1;
    },
  };
}

function rowToReceiveBlockIntent(row: Record<string, unknown>): ReceiveBlockIntent {
  return {
    taskId: row.task_id as string,
    blockHash: row.block_hash as string,
    blockJson: row.block_json as string,
    frontier: row.frontier as string,
    resultingBalanceRaw: row.resulting_balance_raw as string,
    createdAt: row.created_at as string,
  };
}

function rowToAccountOperationLease(row: Record<string, unknown>): AccountOperationLease {
  return {
    accountAddress: row.account_address as string,
    ownerId: row.owner_id as string,
    fencingToken: row.fencing_token as number,
    expiresAt: row.expires_at as string,
  };
}

function rowToInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: row.id as string,
    accountKey: (row.account_key as string) ?? '',
    invoiceKey: (row.invoice_key as string | null) ?? null,
    status: row.status as InvoiceStatus,
    payAddress: row.pay_address as string,
    expectedAmountRaw: row.expected_amount_raw as string,
    receivedAmountRaw: row.received_amount_raw as string,
    memo: row.memo as string | null,
    metadata: row.metadata ? (JSON.parse(row.metadata as string) as Record<string, string> | null) : null,
    idempotencyKey: row.idempotency_key as string | null,
    expiresAt: row.expires_at as string | null,
    completedAt: row.completed_at as string | null,
    canceledAt: row.canceled_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    completionPolicy: JSON.parse(row.completion_policy as string),
    derivationIndex: row.derivation_index != null ? (row.derivation_index as number) : null,
  };
}

function invoiceToRow(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
    account_key: invoice.accountKey,
    invoice_key: invoice.invoiceKey ?? null,
    status: invoice.status,
    pay_address: invoice.payAddress,
    expected_amount_raw: invoice.expectedAmountRaw,
    received_amount_raw: invoice.receivedAmountRaw,
    memo: invoice.memo,
    metadata: invoice.metadata ? JSON.stringify(invoice.metadata) : null,
    idempotency_key: invoice.idempotencyKey,
    expires_at: invoice.expiresAt,
    completed_at: invoice.completedAt,
    canceled_at: invoice.canceledAt,
    created_at: invoice.createdAt,
    updated_at: invoice.updatedAt,
    completion_policy: JSON.stringify(invoice.completionPolicy),
    derivation_index: invoice.derivationIndex ?? null,
  };
}

export function createSqliteInvoiceStore(db: Database): InvoiceStore {
  const insert = db.prepare(`
    INSERT INTO invoices (
      id, account_key, invoice_key, status, pay_address, expected_amount_raw, received_amount_raw,
      memo, metadata, idempotency_key, expires_at, completed_at, canceled_at,
      created_at, updated_at, completion_policy, derivation_index
    ) VALUES (
      @id, @account_key, @invoice_key, @status, @pay_address, @expected_amount_raw, @received_amount_raw,
      @memo, @metadata, @idempotency_key, @expires_at, @completed_at, @canceled_at,
      @created_at, @updated_at, @completion_policy, @derivation_index
    )
  `);

  const insertIdemKey = db.prepare(`
    INSERT OR IGNORE INTO idempotency_keys (key, resource_type, resource_id, created_at)
    VALUES (?, 'invoice', ?, ?)
  `);
  const transition = db.transaction((id: string, expectedStatus: Invoice['status'], patch: Partial<Invoice>) => {
    const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const current = rowToInvoice(row);
    if (current.status !== expectedStatus) return undefined;
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    const values = invoiceToRow(updated);
    const result = db.prepare(`
      UPDATE invoices SET
        account_key = @account_key, invoice_key = @invoice_key,
        status = @status, pay_address = @pay_address, expected_amount_raw = @expected_amount_raw,
        received_amount_raw = @received_amount_raw, memo = @memo, metadata = @metadata,
        idempotency_key = @idempotency_key, expires_at = @expires_at, completed_at = @completed_at,
        canceled_at = @canceled_at, created_at = @created_at, updated_at = @updated_at,
        completion_policy = @completion_policy, derivation_index = @derivation_index
      WHERE id = @id AND status = @expected_status
    `).run({ ...values, expected_status: expectedStatus });
    return result.changes === 1 ? updated : undefined;
  });

  return {
    async create(invoice: Invoice, idempotencyKey?: string): Promise<Invoice> {
      if (idempotencyKey) {
        const existingId = db.prepare('SELECT resource_id FROM idempotency_keys WHERE key = ?').get(idempotencyKey) as { resource_id: string } | undefined;
        if (existingId) {
          const existing = await this.get(existingId.resource_id);
          if (existing) return existing;
        }
      }

      const row = invoiceToRow(invoice);
      insert.run(row);
      if (idempotencyKey) {
        insertIdemKey.run(idempotencyKey, invoice.id, invoice.createdAt);
      }
      return invoice;
    },

    async get(id: string): Promise<Invoice | undefined> {
      const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToInvoice(row) : undefined;
    },

    async getByAccountKeyAndInvoiceKey(accountKey: string, invoiceKey: string | null): Promise<Invoice | undefined> {
      const row = db.prepare(
        'SELECT * FROM invoices WHERE account_key = ? AND (invoice_key = ? OR (invoice_key IS NULL AND ? IS NULL)) ORDER BY created_at ASC LIMIT 1',
      ).get(accountKey, invoiceKey, invoiceKey) as Record<string, unknown> | undefined;
      return row ? rowToInvoice(row) : undefined;
    },

    async list(filter?: { status?: InvoiceStatus }): Promise<Invoice[]> {
      if (filter?.status) {
        const rows = db.prepare('SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC').all(filter.status) as Record<string, unknown>[];
        return rows.map(rowToInvoice);
      }
      const rows = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all() as Record<string, unknown>[];
      return rows.map(rowToInvoice);
    },

    async listByAccountKey(accountKey: string): Promise<Invoice[]> {
      const rows = db.prepare('SELECT * FROM invoices WHERE account_key = ? ORDER BY created_at DESC').all(accountKey) as Record<string, unknown>[];
      return rows.map(rowToInvoice);
    },

    async update(id: string, patch: Partial<Invoice>): Promise<Invoice> {
      const existing = await this.get(id);
      if (!existing) throw new Error(`Invoice ${id} not found`);
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      const row = invoiceToRow(updated);
      db.prepare(`
        UPDATE invoices SET
          account_key = @account_key, invoice_key = @invoice_key,
          status = @status, pay_address = @pay_address, expected_amount_raw = @expected_amount_raw,
          received_amount_raw = @received_amount_raw, memo = @memo, metadata = @metadata,
          idempotency_key = @idempotency_key, expires_at = @expires_at, completed_at = @completed_at,
          canceled_at = @canceled_at, created_at = @created_at, updated_at = @updated_at,
          completion_policy = @completion_policy,
          derivation_index = @derivation_index
        WHERE id = @id
      `).run(row);
      return updated;
    },

    async transition(id, expectedStatus, patch) {
      return transition.immediate(id, expectedStatus, patch);
    },

    async getByPayAddress(address: string, status?: InvoiceStatus): Promise<Invoice[]> {
      if (status) {
        const rows = db.prepare('SELECT * FROM invoices WHERE pay_address = ? AND status = ?').all(address, status) as Record<string, unknown>[];
        return rows.map(rowToInvoice);
      }
      const rows = db.prepare('SELECT * FROM invoices WHERE pay_address = ?').all(address) as Record<string, unknown>[];
      return rows.map(rowToInvoice);
    },

    async getByIdempotencyKey(key: string): Promise<string | undefined> {
      const row = db.prepare('SELECT resource_id FROM idempotency_keys WHERE key = ?').get(key) as { resource_id: string } | undefined;
      return row?.resource_id;
    },
  };
}

function rowToInvoiceAccount(row: Record<string, unknown>): InvoiceAccount {
  return {
    accountKey: row.account_key as string,
    invoiceKey: row.invoice_key as string | null,
    derivationIndex: row.derivation_index as number,
    address: row.address as string,
    createdAt: row.created_at as string,
  };
}

export function createSqliteInvoiceAccountStore(db: Database): InvoiceAccountStore {
  const allocate = db.transaction((
    accountKey: string,
    invoiceKey: string | null,
    derivationStartIndex: number,
    derivationEndIndex: number,
    deriveAddress: (index: number) => string,
  ) => {
    if (invoiceKey !== null) {
      const existing = db.prepare(
        'SELECT * FROM invoice_accounts WHERE account_key = ? AND invoice_key = ?',
      ).get(accountKey, invoiceKey) as Record<string, unknown> | undefined;
      if (existing) return rowToInvoiceAccount(existing);
    }

    const row = db.prepare(`
      SELECT MAX(derivation_index) AS max_index FROM invoice_accounts
      WHERE derivation_index >= ? AND derivation_index < ?
    `).get(derivationStartIndex, derivationEndIndex) as { max_index: number | null };
    const derivationIndex = Math.max(derivationStartIndex, (row.max_index ?? (derivationStartIndex - 1)) + 1);
    if (derivationIndex >= derivationEndIndex) {
      throw new Error(`Invoice derivation range exhausted at index ${derivationEndIndex}`);
    }

    const address = deriveAddress(derivationIndex);
    const createdAt = new Date().toISOString();
    db.prepare(
      'INSERT INTO invoice_accounts (account_key, invoice_key, derivation_index, address, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(accountKey, invoiceKey, derivationIndex, address, createdAt);

    return rowToInvoiceAccount(db.prepare(
      'SELECT * FROM invoice_accounts WHERE derivation_index = ?',
    ).get(derivationIndex) as Record<string, unknown>);
  });

  return {
    async getOrCreate(accountKey, invoiceKey, derivationStartIndex, derivationEndIndex, deriveAddress) {
      return allocate.immediate(accountKey, invoiceKey, derivationStartIndex, derivationEndIndex, deriveAddress);
    },

    async get(accountKey, invoiceKey) {
      const row = invoiceKey === null
        ? db.prepare('SELECT * FROM invoice_accounts WHERE account_key = ? AND invoice_key IS NULL ORDER BY derivation_index DESC LIMIT 1').get(accountKey) as Record<string, unknown> | undefined
        : db.prepare('SELECT * FROM invoice_accounts WHERE account_key = ? AND invoice_key = ?').get(accountKey, invoiceKey) as Record<string, unknown> | undefined;
      return row ? rowToInvoiceAccount(row) : undefined;
    },

    async listByAccountKey(accountKey) {
      const rows = db
        .prepare('SELECT * FROM invoice_accounts WHERE account_key = ? ORDER BY created_at ASC')
        .all(accountKey) as Record<string, unknown>[];
      return rows.map(rowToInvoiceAccount);
    },
  };
}

function rowToReceiveTask(row: Record<string, unknown>): ReceiveTask {
  return {
    id: row.id as string,
    accountAddress: row.account_address as string,
    derivationIndex: row.derivation_index as number,
    pendingBlockHash: row.pending_block_hash as string,
    amountRaw: row.amount_raw as string,
    status: row.status as ReceiveTaskStatus,
    receiveBlockHash: row.receive_block_hash as string | null,
    createdAt: row.created_at as string,
    publishedAt: row.published_at as string | null,
    confirmedAt: row.confirmed_at as string | null,
    failedAt: row.failed_at as string | null,
    failReason: row.fail_reason as string | null,
    retryCount: row.retry_count as number,
  };
}

export function createSqliteReceiveTaskStore(db: Database): ReceiveTaskStore {
  return {
    async create(task) {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const full: ReceiveTask = { ...task, id, createdAt };
      db.prepare(`
        INSERT INTO receive_tasks (
          id, account_address, derivation_index, pending_block_hash, amount_raw,
          status, receive_block_hash, created_at, published_at, confirmed_at, failed_at, fail_reason, retry_count
        ) VALUES (
          @id, @account_address, @derivation_index, @pending_block_hash, @amount_raw,
          @status, @receive_block_hash, @created_at, @published_at, @confirmed_at, @failed_at, @fail_reason, @retry_count
        )
      `).run({
        id,
        account_address: full.accountAddress,
        derivation_index: full.derivationIndex,
        pending_block_hash: full.pendingBlockHash,
        amount_raw: full.amountRaw,
        status: full.status,
        receive_block_hash: full.receiveBlockHash ?? null,
        created_at: createdAt,
        published_at: full.publishedAt ?? null,
        confirmed_at: full.confirmedAt ?? null,
        failed_at: full.failedAt ?? null,
        fail_reason: full.failReason ?? null,
        retry_count: full.retryCount ?? 0,
      });
      return full;
    },

    async get(id) {
      const row = db.prepare('SELECT * FROM receive_tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToReceiveTask(row) : undefined;
    },

    async getByPendingBlockHash(hash) {
      const row = db
        .prepare('SELECT * FROM receive_tasks WHERE pending_block_hash = ?')
        .get(hash) as Record<string, unknown> | undefined;
      return row ? rowToReceiveTask(row) : undefined;
    },

    async listByStatus(status) {
      const rows = db
        .prepare('SELECT * FROM receive_tasks WHERE status = ? ORDER BY created_at ASC')
        .all(status) as Record<string, unknown>[];
      return rows.map(rowToReceiveTask);
    },

    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) throw new Error(`ReceiveTask ${id} not found`);
      const updated = { ...existing, ...patch };
      db.prepare(`
        UPDATE receive_tasks SET
          account_address = @account_address, derivation_index = @derivation_index,
          pending_block_hash = @pending_block_hash, amount_raw = @amount_raw,
          status = @status, receive_block_hash = @receive_block_hash,
          published_at = @published_at, confirmed_at = @confirmed_at,
          failed_at = @failed_at, fail_reason = @fail_reason, retry_count = @retry_count
        WHERE id = @id
      `).run({
        id: updated.id,
        account_address: updated.accountAddress,
        derivation_index: updated.derivationIndex,
        pending_block_hash: updated.pendingBlockHash,
        amount_raw: updated.amountRaw,
        status: updated.status,
        receive_block_hash: updated.receiveBlockHash ?? null,
        published_at: updated.publishedAt ?? null,
        confirmed_at: updated.confirmedAt ?? null,
        failed_at: updated.failedAt ?? null,
        fail_reason: updated.failReason ?? null,
        retry_count: updated.retryCount,
      });
      return updated;
    },
  };
}

function rowToPayment(row: Record<string, unknown>): Payment {
  return {
    id: row.id as string,
    invoiceId: row.invoice_id as string,
    status: row.status as PaymentStatus,
    blockHash: row.block_hash as string,
    senderAddress: row.sender_address as string | null,
    amountRaw: row.amount_raw as string,
    confirmedAt: row.confirmed_at as string | null,
    detectedAt: row.detected_at as string,
  };
}

function rowToDeposit(row: Record<string, unknown>): Deposit {
  return {
    id: row.id as string,
    blockHash: row.block_hash as string,
    recipientAccount: row.recipient_account as string,
    senderAccount: row.sender_account as string | null,
    amountRaw: row.amount_raw as string,
    invoiceId: row.invoice_id as string | null,
    disposition: row.disposition as Deposit['disposition'],
    confirmedAt: row.confirmed_at as string,
  };
}

export function createSqliteDepositStore(db: Database): DepositStore {
  const createIfAbsent = db.transaction((deposit: Deposit): Deposit => {
    db.prepare(`
      INSERT INTO deposits (block_hash, id, recipient_account, sender_account, amount_raw, invoice_id, disposition, confirmed_at)
      VALUES (@block_hash, @id, @recipient_account, @sender_account, @amount_raw, @invoice_id, @disposition, @confirmed_at)
      ON CONFLICT(block_hash) DO UPDATE SET
        invoice_id = COALESCE(deposits.invoice_id, excluded.invoice_id),
        disposition = CASE WHEN deposits.invoice_id IS NULL THEN excluded.disposition ELSE deposits.disposition END
    `).run({
      block_hash: deposit.blockHash,
      id: deposit.id,
      recipient_account: deposit.recipientAccount,
      sender_account: deposit.senderAccount,
      amount_raw: deposit.amountRaw,
      invoice_id: deposit.invoiceId,
      disposition: deposit.disposition,
      confirmed_at: deposit.confirmedAt,
    });
    const row = db.prepare('SELECT * FROM deposits WHERE block_hash = ?').get(deposit.blockHash) as Record<string, unknown>;
    return rowToDeposit(row);
  });

  return {
    async createIfAbsent(deposit) {
      return createIfAbsent(deposit);
    },
    async getByBlockHash(hash) {
      const row = db.prepare('SELECT * FROM deposits WHERE block_hash = ?').get(hash) as Record<string, unknown> | undefined;
      return row ? rowToDeposit(row) : undefined;
    },
    async get(id) {
      const row = db.prepare('SELECT * FROM deposits WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToDeposit(row) : undefined;
    },
    async listByRecipientAccounts(addresses) {
      if (addresses.length === 0) return [];
      const placeholders = addresses.map(() => '?').join(', ');
      const rows = db.prepare(`
        SELECT * FROM deposits WHERE recipient_account IN (${placeholders})
        ORDER BY confirmed_at DESC, block_hash DESC
      `).all(...addresses) as Record<string, unknown>[];
      return rows.map(rowToDeposit);
    },
  };
}

export interface AccountHistoryRecoveryCursorStore {
  get(accountAddress: string): Promise<string | undefined>;
  set(accountAddress: string, blockHash: string): Promise<void>;
}

export interface WebhookOutboxDelivery {
  id: string;
  event: RaiFlowEvent;
  endpoint: WebhookEndpoint;
  attemptCount: number;
}

export interface WebhookOutboxAttempt {
  number: number;
  status: 'delivered' | 'retry' | 'failed';
  responseCode: number | null;
  responseBody: string | null;
  error: string | null;
  nextRetryAt: string | null;
  attemptedAt: string;
}

export interface WebhookOutboxStore {
  claimReady(workerId: string, now: string, leaseUntil: string, limit: number): Promise<WebhookOutboxDelivery[]>;
  recordAttempt(jobId: string, workerId: string, attempt: WebhookOutboxAttempt): Promise<boolean>;
}

function webhookMatchesEvent(eventType: string, filters: string[]): boolean {
  return filters.some((filter) => filter === '*'
    || filter === eventType
    || (filter.endsWith('.*') && eventType.startsWith(filter.slice(0, -1))));
}

function enqueueWebhookOutbox(db: Database, event: RaiFlowEvent, createdAt = new Date().toISOString()): void {
  const endpoints = db.prepare('SELECT id, event_types FROM webhooks').all() as Array<{
    id: string;
    event_types: string;
  }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO webhook_outbox (
      id, event_id, webhook_id, status, attempt_count, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
  `);
  for (const endpoint of endpoints) {
    const filters = JSON.parse(endpoint.event_types) as string[];
    if (webhookMatchesEvent(event.type, filters)) {
      insert.run(randomUUID(), event.id, endpoint.id, createdAt, createdAt, createdAt);
    }
  }
}

export function createSqliteAccountHistoryRecoveryCursorStore(db: Database): AccountHistoryRecoveryCursorStore {
  return {
    async get(accountAddress) {
      const row = db.prepare(`
        SELECT block_hash FROM account_history_recovery_cursors WHERE account_address = ?
      `).get(accountAddress) as { block_hash: string } | undefined;
      return row?.block_hash;
    },
    async set(accountAddress, blockHash) {
      db.prepare(`
        INSERT INTO account_history_recovery_cursors (account_address, block_hash, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_address) DO UPDATE SET
          block_hash = excluded.block_hash,
          updated_at = excluded.updated_at
      `).run(accountAddress, blockHash, new Date().toISOString());
    },
  };
}

const STORAGE_INGEST_HEADROOM_BYTES = 16 * 1024 * 1024;

function sqliteFilesBytes(db: Database, databasePath?: string): number {
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const logicalBytes = Number(db.pragma('page_count', { simple: true })) * pageSize;
  if (!databasePath || databasePath === ':memory:') return logicalBytes;

  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
    .reduce((total, path) => total + (existsSync(path) ? statSync(path).size : 0), 0);
}

export function createSqliteConfirmedDepositIngestStore(
  db: Database,
  options?: Partial<ConfirmedDepositIngestOptions> & { databasePath?: string },
): ConfirmedDepositIngestStore {
  const maxDatabaseBytes = options?.maxDatabaseBytes ?? Number.MAX_SAFE_INTEGER;
  const maxDepositsPerAccount = options?.maxDepositsPerAccount ?? Number.MAX_SAFE_INTEGER;
  const pauseAtBytes = Math.max(0, maxDatabaseBytes - Math.min(
      STORAGE_INGEST_HEADROOM_BYTES,
      Math.floor(maxDatabaseBytes / 8),
  ));
  const getDatabaseBytes = (): number => sqliteFilesBytes(db, options?.databasePath);
  const isGloballyPaused = (): boolean => getDatabaseBytes() >= pauseAtBytes;
  const getStorageBudgetStatus = (): StorageBudgetStatus => {
    const databaseBytes = getDatabaseBytes();
    const pausedAccountCount = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT recipient_account FROM deposits
        GROUP BY recipient_account HAVING COUNT(*) >= ?
      )
    `).get(maxDepositsPerAccount) as { count: number }).count);
    return {
      databaseBytes,
      maxDatabaseBytes,
      remainingBytes: Math.max(0, maxDatabaseBytes - databaseBytes),
      globallyPaused: databaseBytes >= pauseAtBytes,
      pausedAccountCount,
    };
  };

  const appendEvent = (event: RaiFlowEvent): boolean => {
    const result = db.prepare(`
      INSERT INTO events (id, type, timestamp, resource_id, resource_type, data)
      VALUES (@id, @type, @timestamp, @resource_id, @resource_type, @data)
      ON CONFLICT(id) DO NOTHING
    `).run({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      resource_id: event.resourceId,
      resource_type: event.resourceType,
      data: JSON.stringify(event.data),
    });
    if (result.changes === 1) enqueueWebhookOutbox(db, event, event.timestamp);
    return result.changes === 1;
  };

  const ensureReceiveTask = (block: ConfirmedBlock): void => {
    if (block.alreadyReceived) return;
    const invoiceAddress = db.prepare(`
      SELECT derivation_index FROM invoice_accounts WHERE address = ?
    `).get(block.recipientAccount) as { derivation_index: number } | undefined;
    const managedAccount = invoiceAddress ? undefined : db.prepare(`
      SELECT derivation_index FROM accounts WHERE address = ? AND derivation_index IS NOT NULL
    `).get(block.recipientAccount) as { derivation_index: number } | undefined;
    const derivationIndex = invoiceAddress?.derivation_index ?? managedAccount?.derivation_index;
    if (derivationIndex === undefined) return;

    db.prepare(`
      INSERT INTO receive_tasks (
        id, account_address, derivation_index, pending_block_hash, amount_raw,
        status, created_at, retry_count
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0)
      ON CONFLICT(pending_block_hash) DO NOTHING
    `).run(randomUUID(), block.recipientAccount, derivationIndex, block.blockHash, block.amountRaw, new Date().toISOString());
  };

  const transaction = db.transaction((block: ConfirmedBlock): ConfirmedDepositIngestResult => {
    const existingDepositRow = db.prepare('SELECT * FROM deposits WHERE block_hash = ?').get(block.blockHash) as Record<string, unknown> | undefined;
    const existingPaymentRow = db.prepare('SELECT * FROM payments WHERE block_hash = ?').get(block.blockHash) as Record<string, unknown> | undefined;
    const candidateInvoiceRow = db.prepare(`
      SELECT * FROM invoices WHERE pay_address = ? ORDER BY created_at ASC LIMIT 1
    `).get(block.recipientAccount) as Record<string, unknown> | undefined;
    const invoiceId = (existingPaymentRow?.['invoice_id'] as string | undefined)
      ?? (existingDepositRow?.['invoice_id'] as string | undefined)
      ?? (!existingDepositRow ? (candidateInvoiceRow?.['id'] as string | undefined) : undefined)
      ?? null;
    const invoiceRow = invoiceId
      ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as Record<string, unknown> | undefined
      : undefined;
    if (invoiceId && !invoiceRow) throw new Error(`Invoice ${invoiceId} not found while ingesting deposit ${block.blockHash}`);

    // Existing evidence can be replayed at the limit. New sends stop before
    // writing a deposit, payment, event, webhook job, or receive task.
    if (!existingDepositRow) {
      if (isGloballyPaused()) {
        throw new StorageBudgetExceededError('global');
      }
      const accountDepositCount = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM deposits WHERE recipient_account = ?
      `).get(block.recipientAccount) as { count: number }).count);
      if (accountDepositCount >= maxDepositsPerAccount) {
        throw new StorageBudgetExceededError('account');
      }
    }

    let disposition: Deposit['disposition'];
    if (existingDepositRow) {
      disposition = rowToDeposit(existingDepositRow).disposition;
    } else if (!invoiceRow) {
      disposition = 'unmatched';
    } else if (invoiceRow['status'] !== 'open') {
      disposition = 'late';
    } else {
      const priorAmounts = db.prepare(`
        SELECT amount_raw FROM payments WHERE invoice_id = ? AND status = 'confirmed'
      `).all(invoiceId) as Array<{ amount_raw: string }>;
      const priorTotal = priorAmounts.reduce((sum, row) => sum + BigInt(row.amount_raw), 0n);
      const projectedTotal = priorTotal + (existingPaymentRow ? 0n : BigInt(block.amountRaw));
      const expected = BigInt(invoiceRow['expected_amount_raw'] as string);
      disposition = projectedTotal > expected ? 'excess' : projectedTotal < expected ? 'partial' : 'matched';
    }

    let deposit: Deposit;
    let created = false;
    if (existingDepositRow) {
      deposit = rowToDeposit(existingDepositRow);
      if (deposit.invoiceId === null && invoiceId !== null) {
        db.prepare('UPDATE deposits SET invoice_id = ? WHERE block_hash = ? AND invoice_id IS NULL')
          .run(invoiceId, deposit.blockHash);
        deposit = { ...deposit, invoiceId };
      }
    } else {
      deposit = {
        id: randomUUID(),
        blockHash: block.blockHash,
        recipientAccount: block.recipientAccount,
        senderAccount: block.senderAccount || null,
        amountRaw: block.amountRaw,
        invoiceId,
        disposition,
        confirmedAt: block.confirmedAt,
      };
      db.prepare(`
        INSERT INTO deposits (block_hash, id, recipient_account, sender_account, amount_raw, invoice_id, disposition, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(deposit.blockHash, deposit.id, deposit.recipientAccount, deposit.senderAccount, deposit.amountRaw, deposit.invoiceId, deposit.disposition, deposit.confirmedAt);
      created = true;
    }

    ensureReceiveTask(block);

    const events: RaiFlowEvent[] = [];
    const hasDepositEvent = Boolean(db.prepare(`
      SELECT 1 FROM events WHERE type = 'deposit.observed'
        AND json_extract(data, '$.deposit.blockHash') = ?
    `).get(block.blockHash));
    if (!hasDepositEvent) {
      const event: RaiFlowEvent = {
        id: randomUUID(),
        type: 'deposit.observed',
        timestamp: block.confirmedAt,
        data: { deposit },
        resourceId: deposit.id,
        resourceType: 'deposit',
      };
      if (appendEvent(event)) events.push(event);
    }

    let payment: Payment | undefined;
    if (!invoiceId || !invoiceRow || disposition === 'late') return { deposit, created, events };
    if (existingPaymentRow) {
      payment = rowToPayment(existingPaymentRow);
    } else {
      payment = {
        id: randomUUID(),
        invoiceId,
        status: 'confirmed',
        blockHash: block.blockHash,
        senderAddress: block.senderAccount || null,
        amountRaw: block.amountRaw,
        confirmedAt: block.confirmedAt,
        detectedAt: block.confirmedAt,
      };
      db.prepare(`
        INSERT INTO payments (id, invoice_id, status, block_hash, sender_address, amount_raw, confirmed_at, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(payment.id, payment.invoiceId, payment.status, payment.blockHash, payment.senderAddress, payment.amountRaw, payment.confirmedAt, payment.detectedAt);
    }

    if (!payment) return { deposit, created, events };

    const amounts = db.prepare(`
      SELECT amount_raw FROM payments WHERE invoice_id = ? AND status = 'confirmed'
    `).all(invoiceId) as Array<{ amount_raw: string }>;
    const receivedAmountRaw = amounts.reduce((sum, row) => sum + BigInt(row.amount_raw), 0n).toString();
    const expectedAmountRaw = invoiceRow['expected_amount_raw'] as string;
    const completionPolicy = JSON.parse(invoiceRow['completion_policy'] as string) as { type?: string };
    const isComplete = completionPolicy.type === 'exact'
      ? BigInt(receivedAmountRaw) === BigInt(expectedAmountRaw)
      : BigInt(receivedAmountRaw) >= BigInt(expectedAmountRaw);
    const previousStatus = invoiceRow['status'] as string;
    const nextStatus = previousStatus === 'open' && isComplete ? 'completed' : previousStatus;
    const updatedAt = new Date().toISOString();
    const completedAt = nextStatus === 'completed'
      ? (invoiceRow['completed_at'] as string | null) ?? new Date().toISOString()
      : invoiceRow['completed_at'] as string | null;
    const paymentInvoice = rowToInvoice({
      ...invoiceRow,
      received_amount_raw: receivedAmountRaw,
      updated_at: updatedAt,
    });
    db.prepare(`
      UPDATE invoices SET received_amount_raw = ?, status = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(receivedAmountRaw, nextStatus, completedAt, updatedAt, invoiceId);
    const updatedInvoiceRow = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as Record<string, unknown>;
    const updatedInvoice = rowToInvoice(updatedInvoiceRow);
    const paymentReceived: RaiFlowEvent = {
      id: randomUUID(),
      type: 'invoice.payment_received',
      timestamp: block.confirmedAt,
      data: { payment, invoice: paymentInvoice },
      resourceId: invoiceId,
      resourceType: 'invoice',
    };
    const paymentConfirmed: RaiFlowEvent = {
      ...paymentReceived,
      id: randomUUID(),
      type: 'invoice.payment_confirmed',
    };
    const hasPaymentEvent = (type: string): boolean => Boolean(db.prepare(`
      SELECT 1 FROM events
      WHERE type = ? AND (
        json_extract(data, '$.payment.blockHash') = ? OR
        json_extract(data, '$.payment.sendBlockHash') = ?
      )
    `).get(type, block.blockHash, block.blockHash));
    if (!hasPaymentEvent(paymentReceived.type) && appendEvent(paymentReceived)) events.push(paymentReceived);
    if (!hasPaymentEvent(paymentConfirmed.type) && appendEvent(paymentConfirmed)) events.push(paymentConfirmed);
    const hasCompletionEvent = Boolean(db.prepare(`
      SELECT 1 FROM events WHERE type = 'invoice.completed' AND resource_id = ?
    `).get(invoiceId));
    if (nextStatus === 'completed' && !hasCompletionEvent) {
      const completedEvent: RaiFlowEvent = {
        id: randomUUID(),
        type: 'invoice.completed',
        timestamp: block.confirmedAt,
        data: { invoice: updatedInvoice },
        resourceId: invoiceId,
        resourceType: 'invoice',
      };
      if (appendEvent(completedEvent)) events.push(completedEvent);
    }

    return { deposit, payment, created, events };
  });

  return {
    async ingest(block) {
      return transaction.immediate(block);
    },
    getStorageBudgetStatus,
  };
}

export function createSqlitePaymentStore(db: Database): PaymentStore {
  return {
    async create(payment: Payment): Promise<Payment> {
      db.prepare(`
        INSERT INTO payments (id, invoice_id, status, block_hash, sender_address, amount_raw, confirmed_at, detected_at)
        VALUES (@id, @invoice_id, @status, @block_hash, @sender_address, @amount_raw, @confirmed_at, @detected_at)
      `).run({
        id: payment.id,
        invoice_id: payment.invoiceId,
        status: payment.status,
        block_hash: payment.blockHash,
        sender_address: payment.senderAddress,
        amount_raw: payment.amountRaw,
        confirmed_at: payment.confirmedAt,
        detected_at: payment.detectedAt,
      });
      return payment;
    },

    async get(id: string): Promise<Payment | undefined> {
      const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToPayment(row) : undefined;
    },

    async getByBlockHash(hash: string): Promise<Payment | undefined> {
      const row = db.prepare('SELECT * FROM payments WHERE block_hash = ?').get(hash) as Record<string, unknown> | undefined;
      return row ? rowToPayment(row) : undefined;
    },

    async listByInvoice(invoiceId: string): Promise<Payment[]> {
      const rows = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY detected_at DESC').all(invoiceId) as Record<string, unknown>[];
      return rows.map(rowToPayment);
    },
  };
}

function rowToAccount(row: Record<string, unknown>): Account {
  return {
    id: row.id as string,
    accountKey: row.account_key as string | null,
    type: row.type as AccountType,
    address: row.address as string,
    label: row.label as string | null,
    balanceRaw: row.balance_raw as string,
    pendingRaw: row.pending_raw as string,
    frontier: row.frontier as string | null,
    representative: row.representative as string | null,
    derivationIndex: row.derivation_index as number | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createSqliteAccountStore(db: Database): AccountStore {
  return {
    async create(account: Account): Promise<Account> {
      db.prepare(`
        INSERT INTO accounts (id, account_key, type, address, label, balance_raw, pending_raw, frontier, representative, derivation_index, created_at, updated_at)
        VALUES (@id, @account_key, @type, @address, @label, @balance_raw, @pending_raw, @frontier, @representative, @derivation_index, @created_at, @updated_at)
      `).run({
        id: account.id,
        account_key: account.accountKey,
        type: account.type,
        address: account.address,
        label: account.label,
        balance_raw: account.balanceRaw,
        pending_raw: account.pendingRaw,
        frontier: account.frontier,
        representative: account.representative,
        derivation_index: account.derivationIndex,
        created_at: account.createdAt,
        updated_at: account.updatedAt,
      });
      return account;
    },

    async get(id: string): Promise<Account | undefined> {
      const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToAccount(row) : undefined;
    },

    async getByAddress(address: string): Promise<Account | undefined> {
      const row = db.prepare('SELECT * FROM accounts WHERE address = ?').get(address) as Record<string, unknown> | undefined;
      return row ? rowToAccount(row) : undefined;
    },

    async list(filter?: { type?: AccountType }): Promise<Account[]> {
      if (filter?.type) {
        const rows = db.prepare('SELECT * FROM accounts WHERE type = ? ORDER BY created_at DESC').all(filter.type) as Record<string, unknown>[];
        return rows.map(rowToAccount);
      }
      const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all() as Record<string, unknown>[];
      return rows.map(rowToAccount);
    },

    async update(id: string, patch: Partial<Account>): Promise<Account> {
      const existing = await this.get(id);
      if (!existing) throw new Error(`Account ${id} not found`);
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      db.prepare(`
        UPDATE accounts SET
          account_key = @account_key, type = @type, address = @address, label = @label, balance_raw = @balance_raw,
          pending_raw = @pending_raw, frontier = @frontier, representative = @representative,
          derivation_index = @derivation_index, created_at = @created_at, updated_at = @updated_at
        WHERE id = @id
      `).run({
        id: updated.id,
        account_key: updated.accountKey,
        type: updated.type,
        address: updated.address,
        label: updated.label,
        balance_raw: updated.balanceRaw,
        pending_raw: updated.pendingRaw,
        frontier: updated.frontier,
        representative: updated.representative,
        derivation_index: updated.derivationIndex,
        created_at: updated.createdAt,
        updated_at: updated.updatedAt,
      });
      return updated;
    },

    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      return result.changes > 0;
    },
  };
}

function rowToSend(row: Record<string, unknown>): Send {
  const source: Send['source'] = row.source_type === 'invoice'
    ? {
      type: 'invoice',
      invoiceId: row.source_invoice_id as string,
      address: row.source_address as string,
      derivationIndex: row.source_derivation_index as number,
    }
    : {
      type: 'account',
      accountId: row.account_id as string,
      address: row.source_address as string,
      derivationIndex: row.source_derivation_index as number | null,
    };
  return {
    id: row.id as string,
    source,
    destination: row.destination as string,
    amountRaw: row.amount_raw as string,
    status: row.status as SendStatus,
    blockHash: row.block_hash as string | null,
    idempotencyKey: row.idempotency_key as string,
    createdAt: row.created_at as string,
    publishedAt: row.published_at as string | null,
    confirmedAt: row.confirmed_at as string | null,
  };
}

export function createSqliteSendStore(db: Database): SendStore {
  return {
    async create(send: Send): Promise<Send> {
      db.prepare(`
        INSERT INTO sends (id, account_id, source_type, source_address, source_derivation_index, source_invoice_id,
          destination, amount_raw, status, block_hash, idempotency_key, created_at, published_at, confirmed_at)
        VALUES (@id, @account_id, @source_type, @source_address, @source_derivation_index, @source_invoice_id,
          @destination, @amount_raw, @status, @block_hash, @idempotency_key, @created_at, @published_at, @confirmed_at)
      `).run({
        id: send.id,
        account_id: send.source.type === 'account' ? send.source.accountId : null,
        source_type: send.source.type,
        source_address: send.source.address,
        source_derivation_index: send.source.derivationIndex,
        source_invoice_id: send.source.type === 'invoice' ? send.source.invoiceId : null,
        destination: send.destination,
        amount_raw: send.amountRaw,
        status: send.status,
        block_hash: send.blockHash,
        idempotency_key: send.idempotencyKey,
        created_at: send.createdAt,
        published_at: send.publishedAt,
        confirmed_at: send.confirmedAt,
      });
      return send;
    },

    async get(id: string): Promise<Send | undefined> {
      const row = db.prepare('SELECT * FROM sends WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToSend(row) : undefined;
    },

    async getByBlockHash(hash: string): Promise<Send | undefined> {
      const row = db.prepare('SELECT * FROM sends WHERE block_hash = ?').get(hash) as Record<string, unknown> | undefined;
      return row ? rowToSend(row) : undefined;
    },

    async listByAccount(accountId: string): Promise<Send[]> {
      const rows = db.prepare('SELECT * FROM sends WHERE account_id = ? ORDER BY created_at DESC').all(accountId) as Record<string, unknown>[];
      return rows.map(rowToSend);
    },

    async listByStatus(status: SendStatus): Promise<Send[]> {
      const rows = db.prepare('SELECT * FROM sends WHERE status = ? ORDER BY created_at DESC').all(status) as Record<string, unknown>[];
      return rows.map(rowToSend);
    },

    async getByIdempotencyKey(key: string): Promise<Send | undefined> {
      const row = db.prepare('SELECT * FROM sends WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
      return row ? rowToSend(row) : undefined;
    },

    async update(id: string, patch: Partial<Send>): Promise<Send> {
      const existing = await this.get(id);
      if (!existing) throw new Error(`Send ${id} not found`);
      const updated = { ...existing, ...patch };
      db.prepare(`
        UPDATE sends SET
          account_id = @account_id, source_type = @source_type, source_address = @source_address,
          source_derivation_index = @source_derivation_index, source_invoice_id = @source_invoice_id,
          destination = @destination, amount_raw = @amount_raw,
          status = @status, block_hash = @block_hash, idempotency_key = @idempotency_key,
          created_at = @created_at, published_at = @published_at, confirmed_at = @confirmed_at
        WHERE id = @id
      `).run({
        id: updated.id,
        account_id: updated.source.type === 'account' ? updated.source.accountId : null,
        source_type: updated.source.type,
        source_address: updated.source.address,
        source_derivation_index: updated.source.derivationIndex,
        source_invoice_id: updated.source.type === 'invoice' ? updated.source.invoiceId : null,
        destination: updated.destination,
        amount_raw: updated.amountRaw,
        status: updated.status,
        block_hash: updated.blockHash,
        idempotency_key: updated.idempotencyKey,
        created_at: updated.createdAt,
        published_at: updated.publishedAt,
        confirmed_at: updated.confirmedAt,
      });
      return updated;
    },
  };
}

function rowToRefund(row: Record<string, unknown>, send: Send): Refund {
  return {
    id: row.id as string,
    depositId: row.deposit_id as string,
    invoiceId: row.invoice_id as string | null,
    sendId: row.send_id as string,
    destination: row.destination as string,
    amountRaw: row.amount_raw as string,
    status: send.status,
    idempotencyKey: row.idempotency_key as string,
    createdAt: row.created_at as string,
    publishedAt: send.publishedAt,
    confirmedAt: send.confirmedAt,
  };
}

export function createSqliteRefundStore(db: Database): RefundStore {
  const getResult = (refundRow: Record<string, unknown>, created: boolean): RefundQueueResult => {
    const sendId = refundRow.send_id as string;
    const sendRow = db.prepare('SELECT * FROM sends WHERE id = ?').get(sendId) as Record<string, unknown> | undefined;
    if (!sendRow) throw new Error(`Refund ${refundRow['id']} has no durable send`);
    const send = rowToSend(sendRow);
    return { refund: rowToRefund(refundRow, send), send, created };
  };

  const queue = db.transaction((deposit: Deposit, refund: Refund, send: Send): RefundQueueResult => {
    const invoiceSourceMatches = deposit.invoiceId
      ? send.source.type === 'invoice' && send.source.invoiceId === deposit.invoiceId
      : send.source.type === 'account';
    if (refund.depositId !== deposit.id || refund.invoiceId !== deposit.invoiceId
      || refund.sendId !== send.id || refund.destination !== send.destination
      || refund.amountRaw !== send.amountRaw || refund.idempotencyKey.length === 0
      || send.source.address !== deposit.recipientAccount || !invoiceSourceMatches
      || send.status !== 'queued' || send.blockHash !== null) {
      throw new Error('Refund and durable send do not match the confirmed deposit');
    }
    const existingRow = db.prepare('SELECT * FROM refunds WHERE deposit_id = ? AND idempotency_key = ?').get(deposit.id, refund.idempotencyKey) as Record<string, unknown> | undefined;
    if (existingRow) {
      if (existingRow['deposit_id'] !== deposit.id
        || existingRow['destination'] !== refund.destination
        || existingRow['amount_raw'] !== refund.amountRaw) {
        throw new Error('Refund idempotency key was reused with different parameters');
      }
      const existing = getResult(existingRow, false);
      if (existing.send.source.address !== send.source.address) {
        throw new Error('Refund idempotency key was reused with a different source account');
      }
      return existing;
    }

    const storedDeposit = db.prepare('SELECT amount_raw FROM deposits WHERE id = ?').get(deposit.id) as { amount_raw: string } | undefined;
    if (!storedDeposit) throw new Error(`Deposit ${deposit.id} not found`);
    const activeRefunds = db.prepare(`
      SELECT refunds.amount_raw FROM refunds
      JOIN sends ON sends.id = refunds.send_id
      WHERE refunds.deposit_id = ? AND sends.status IN ('queued', 'published', 'confirmed')
    `).all(deposit.id) as Array<{ amount_raw: string }>;
    const refundedRaw = activeRefunds.reduce((total, row) => total + BigInt(row.amount_raw), 0n);
    if (refundedRaw + BigInt(refund.amountRaw) > BigInt(storedDeposit.amount_raw)) {
      throw new Error('Refund amount exceeds the unrefunded deposit amount');
    }

    db.prepare(`
      INSERT INTO sends (id, account_id, source_type, source_address, source_derivation_index, source_invoice_id,
        destination, amount_raw, status, block_hash, idempotency_key, created_at, published_at, confirmed_at)
      VALUES (@id, @account_id, @source_type, @source_address, @source_derivation_index, @source_invoice_id,
        @destination, @amount_raw, @status, @block_hash, @idempotency_key, @created_at, @published_at, @confirmed_at)
    `).run({
      id: send.id,
      account_id: send.source.type === 'account' ? send.source.accountId : null,
      source_type: send.source.type,
      source_address: send.source.address,
      source_derivation_index: send.source.derivationIndex,
      source_invoice_id: send.source.type === 'invoice' ? send.source.invoiceId : null,
      destination: send.destination,
      amount_raw: send.amountRaw,
      status: send.status,
      block_hash: send.blockHash,
      idempotency_key: send.idempotencyKey,
      created_at: send.createdAt,
      published_at: send.publishedAt,
      confirmed_at: send.confirmedAt,
    });
    db.prepare(`
      INSERT INTO refunds (id, deposit_id, invoice_id, send_id, destination, amount_raw, idempotency_key, created_at)
      VALUES (@id, @deposit_id, @invoice_id, @send_id, @destination, @amount_raw, @idempotency_key, @created_at)
    `).run({
      id: refund.id,
      deposit_id: deposit.id,
      invoice_id: deposit.invoiceId,
      send_id: send.id,
      destination: refund.destination,
      amount_raw: refund.amountRaw,
      idempotency_key: refund.idempotencyKey,
      created_at: refund.createdAt,
    });
    const storedRefund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refund.id) as Record<string, unknown>;
    return getResult(storedRefund, true);
  });

  return {
    async queue(deposit, refund, send) {
      return queue(deposit, refund, send);
    },
    async listByDepositId(depositId) {
      const rows = db.prepare('SELECT * FROM refunds WHERE deposit_id = ? ORDER BY created_at, id').all(depositId) as Record<string, unknown>[];
      return rows.map((row) => getResult(row, false).refund);
    },
  };
}

function rowToEvent(row: Record<string, unknown>): RaiFlowEvent {
  return {
    sequence: row.sequence as number,
    id: row.id as string,
    type: row.type as string,
    timestamp: row.timestamp as string,
    data: JSON.parse(row.data as string) as Record<string, unknown>,
    resourceId: row.resource_id as string,
    resourceType: row.resource_type as RaiFlowEvent['resourceType'],
  };
}

export function createSqliteEventStore(db: Database): EventStore {
  const appendWithOutbox = db.transaction((event: RaiFlowEvent): void => {
    const result = db.prepare(`
      INSERT INTO events (id, type, timestamp, resource_id, resource_type, data)
      VALUES (@id, @type, @timestamp, @resource_id, @resource_type, @data)
      ON CONFLICT(id) DO NOTHING
    `).run({
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      resource_id: event.resourceId,
      resource_type: event.resourceType,
      data: JSON.stringify(event.data),
    });
    if (result.changes === 1) enqueueWebhookOutbox(db, event, event.timestamp);
  });

  return {
    async append(event: RaiFlowEvent): Promise<void> {
      appendWithOutbox(event);
    },

    async list(options?: EventQueryOptions): Promise<RaiFlowEvent[]> {
      const limit = options?.limit ?? 100;
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options?.after) {
        if (!/^\d+$/.test(options.after)) {
          throw new Error('event cursor must be a positive integer sequence');
        }
        conditions.push('sequence > ?');
        params.push(Number(options.after));
      }
      if (options?.type) {
        conditions.push('type = ?');
        params.push(options.type);
      }
      if (options?.resourceType) {
        conditions.push('resource_type = ?');
        params.push(options.resourceType);
      }
      if (options?.resourceId) {
        conditions.push('resource_id = ?');
        params.push(options.resourceId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT * FROM events ${where} ORDER BY sequence ASC LIMIT ${limit + 1}`;
      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      return rows.slice(0, limit).map(rowToEvent);
    },
  };
}

function rowToWebhook(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row.id as string,
    url: row.url as string,
    secret: row.secret as string,
    eventTypes: JSON.parse(row.event_types as string) as string[],
    createdAt: row.created_at as string,
  };
}

export function createSqliteWebhookOutboxStore(db: Database): WebhookOutboxStore {
  const claim = db.transaction((workerId: string, now: string, leaseUntil: string, limit: number): WebhookOutboxDelivery[] => {
    const due = db.prepare(`
      SELECT id FROM webhook_outbox
      WHERE (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'processing' AND lease_until <= ?)
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT ?
    `).all(now, now, limit) as Array<{ id: string }>;
    if (due.length === 0) return [];
    const update = db.prepare(`
      UPDATE webhook_outbox
      SET status = 'processing', lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND (
        (status = 'pending' AND next_attempt_at <= ?)
        OR (status = 'processing' AND lease_until <= ?)
      )
    `);
    for (const row of due) update.run(workerId, leaseUntil, now, row.id, now, now);
    const ids = due.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT
        o.id AS outbox_id, o.attempt_count,
        e.sequence, e.id, e.type, e.timestamp, e.resource_id, e.resource_type, e.data,
        w.id AS endpoint_id, w.url, w.secret, w.event_types, w.created_at AS endpoint_created_at
      FROM webhook_outbox AS o
      JOIN events AS e ON e.id = o.event_id
      JOIN webhooks AS w ON w.id = o.webhook_id
      WHERE o.lease_owner = ? AND o.id IN (${placeholders})
      ORDER BY o.next_attempt_at ASC, o.created_at ASC
    `).all(workerId, ...ids) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.outbox_id as string,
      attemptCount: row.attempt_count as number,
      event: rowToEvent(row),
      endpoint: {
        id: row.endpoint_id as string,
        url: row.url as string,
        secret: row.secret as string,
        eventTypes: JSON.parse(row.event_types as string) as string[],
        createdAt: row.endpoint_created_at as string,
      },
    }));
  });

  const record = db.transaction((jobId: string, workerId: string, attempt: WebhookOutboxAttempt): boolean => {
    const status = attempt.status === 'retry' ? 'pending' : attempt.status;
    const update = db.prepare(`
      UPDATE webhook_outbox SET
        status = ?, attempt_count = ?, next_attempt_at = COALESCE(?, next_attempt_at),
        lease_owner = NULL, lease_until = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ?
    `).run(
      status,
      attempt.number,
      attempt.nextRetryAt,
      attempt.error,
      attempt.attemptedAt,
      jobId,
      workerId,
    );
    if (update.changes !== 1) return false;
    const job = db.prepare('SELECT webhook_id, event_id FROM webhook_outbox WHERE id = ?').get(jobId) as {
      webhook_id: string;
      event_id: string;
    };
    db.prepare(`
      INSERT INTO webhook_deliveries (
        id, webhook_id, event_id, attempt, status, response_code, response_body, next_retry_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      job.webhook_id,
      job.event_id,
      attempt.number,
      attempt.status,
      attempt.responseCode,
      attempt.responseBody ?? attempt.error,
      attempt.nextRetryAt,
      attempt.attemptedAt,
    );
    return true;
  });

  return {
    async claimReady(workerId, now, leaseUntil, limit) {
      return claim.immediate(workerId, now, leaseUntil, Math.max(1, Math.min(limit, 100)));
    },
    async recordAttempt(jobId, workerId, attempt) {
      return record.immediate(jobId, workerId, attempt);
    },
  };
}

export function createSqliteWebhookStore(db: Database): WebhookEndpointStore {
  return {
    async create(endpoint: Omit<WebhookEndpoint, 'id' | 'createdAt'> & { secret?: string }): Promise<WebhookEndpoint> {
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const secret = endpoint.secret ?? crypto.randomUUID();
      db.prepare(`
        INSERT INTO webhooks (id, url, secret, event_types, created_at)
        VALUES (@id, @url, @secret, @event_types, @created_at)
      `).run({
        id,
        url: endpoint.url,
        secret,
        event_types: JSON.stringify(endpoint.eventTypes),
        created_at: createdAt,
      });
      return { id, url: endpoint.url, secret, eventTypes: endpoint.eventTypes, createdAt };
    },

    async get(id: string): Promise<WebhookEndpoint | undefined> {
      const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToWebhook(row) : undefined;
    },

    async list(): Promise<WebhookEndpoint[]> {
      const rows = db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as Record<string, unknown>[];
      return rows.map(rowToWebhook);
    },

    async delete(id: string): Promise<boolean> {
      const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
      return result.changes > 0;
    },

    async getByEventType(eventType: string): Promise<WebhookEndpoint[]> {
      const rows = db.prepare('SELECT * FROM webhooks').all() as Record<string, unknown>[];
      return rows
        .map(rowToWebhook)
        .filter((w) => w.eventTypes.includes('*') || w.eventTypes.includes(eventType));
    },
  };
}

function scopedIdempotencyKey(scope: string, key: string): string {
  return `${scope}:${key}`;
}

function rowToIdempotencyRecord(row: Record<string, unknown>): IdempotencyRecord {
  const rawKey = row.key as string;
  const splitIdx = rawKey.indexOf(':');
  const scope = splitIdx >= 0 ? rawKey.slice(0, splitIdx) : 'default';
  const key = splitIdx >= 0 ? rawKey.slice(splitIdx + 1) : rawKey;
  return {
    key,
    scope,
    resourceType: row.resource_type as string,
    resourceId: row.resource_id as string,
    createdAt: row.created_at as string,
  };
}

export function createSqliteIdempotencyReplayStore(db: Database): IdempotencyReplayStore {
  return {
    async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
      const row = db
        .prepare('SELECT * FROM idempotency_keys WHERE key = ?')
        .get(scopedIdempotencyKey(scope, key)) as Record<string, unknown> | undefined;
      return row ? rowToIdempotencyRecord(row) : undefined;
    },

    async put(scope: string, key: string, resourceType: string, resourceId: string): Promise<IdempotencyRecord> {
      const scopedKey = scopedIdempotencyKey(scope, key);
      const createdAt = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO idempotency_keys (key, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(scopedKey, resourceType, resourceId, createdAt);

      const row = db
        .prepare('SELECT * FROM idempotency_keys WHERE key = ?')
        .get(scopedKey) as Record<string, unknown> | undefined;
      if (!row) {
        throw new Error(`Failed to persist idempotency key for scope=${scope}`);
      }
      return rowToIdempotencyRecord(row);
    },
  };
}
