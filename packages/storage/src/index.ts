// @openrai/storage — Persistent data access layer

import type {
  Invoice,
  InvoiceStore,
  InvoiceStatus,
  Payment,
  PaymentStore,
  PaymentStatus,
  Account,
  AccountStore,
  AccountType,
  Send,
  SendStore,
  SendStatus,
  EventStore,
  RaiFlowEvent,
  WebhookEndpoint,
  WebhookEndpointStore,
  EventQueryOptions,
} from '@openrai/model';
import type BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

export interface StorageConfig {
  driver: 'sqlite';
  path: string;
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

export function createDatabase(path: string): Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const DB = require('better-sqlite3') as typeof BetterSqlite3;
  const db = new DB(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function createMigrationRunner(db: Database): MigrationRunner {
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
            pay_address TEXT NOT NULL UNIQUE,
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
            id TEXT PRIMARY KEY,
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

          CREATE INDEX IF NOT EXISTS idx_events_resource ON events(resource_type, resource_id, id);
          CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id);
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
  ];

  return {
    up(): Promise<void> {
      for (const m of migrations) {
        const row = db.prepare('SELECT id FROM migrations WHERE id = ?').get(m.id);
        if (!row) {
          m.up(db);
          db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
            m.id,
            m.name,
            new Date().toISOString(),
          );
        }
      }
      return Promise.resolve();
    },
    getApplied(): string[] {
      const rows = db.prepare('SELECT name FROM migrations ORDER BY id').all() as { name: string }[];
      return rows.map((r) => r.name);
    },
  };
}

function rowToInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: row.id as string,
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
  };
}

function invoiceToRow(invoice: Invoice): Record<string, unknown> {
  return {
    id: invoice.id,
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
  };
}

export function createSqliteInvoiceStore(db: Database): InvoiceStore {
  const insert = db.prepare(`
    INSERT INTO invoices (
      id, status, pay_address, expected_amount_raw, received_amount_raw,
      memo, metadata, idempotency_key, expires_at, completed_at, canceled_at,
      created_at, updated_at, completion_policy
    ) VALUES (
      @id, @status, @pay_address, @expected_amount_raw, @received_amount_raw,
      @memo, @metadata, @idempotency_key, @expires_at, @completed_at, @canceled_at,
      @created_at, @updated_at, @completion_policy
    )
  `);

  const insertIdemKey = db.prepare(`
    INSERT OR IGNORE INTO idempotency_keys (key, resource_type, resource_id, created_at)
    VALUES (?, 'invoice', ?, ?)
  `);

  return {
    async create(invoice: Invoice, idempotencyKey?: string): Promise<Invoice> {
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

    async list(filter?: { status?: InvoiceStatus }): Promise<Invoice[]> {
      if (filter?.status) {
        const rows = db.prepare('SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC').all(filter.status) as Record<string, unknown>[];
        return rows.map(rowToInvoice);
      }
      const rows = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC').all() as Record<string, unknown>[];
      return rows.map(rowToInvoice);
    },

    async update(id: string, patch: Partial<Invoice>): Promise<Invoice> {
      const existing = await this.get(id);
      if (!existing) throw new Error(`Invoice ${id} not found`);
      const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      const row = invoiceToRow(updated);
      db.prepare(`
        UPDATE invoices SET
          status = @status, pay_address = @pay_address, expected_amount_raw = @expected_amount_raw,
          received_amount_raw = @received_amount_raw, memo = @memo, metadata = @metadata,
          idempotency_key = @idempotency_key, expires_at = @expires_at, completed_at = @completed_at,
          canceled_at = @canceled_at, created_at = @created_at, updated_at = @updated_at,
          completion_policy = @completion_policy
        WHERE id = @id
      `).run(row);
      return updated;
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
        INSERT INTO accounts (id, type, address, label, balance_raw, pending_raw, frontier, representative, derivation_index, created_at, updated_at)
        VALUES (@id, @type, @address, @label, @balance_raw, @pending_raw, @frontier, @representative, @derivation_index, @created_at, @updated_at)
      `).run({
        id: account.id,
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
          type = @type, address = @address, label = @label, balance_raw = @balance_raw,
          pending_raw = @pending_raw, frontier = @frontier, representative = @representative,
          derivation_index = @derivation_index, created_at = @created_at, updated_at = @updated_at
        WHERE id = @id
      `).run({
        id: updated.id,
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
  };
}

function rowToSend(row: Record<string, unknown>): Send {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
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
        INSERT INTO sends (id, account_id, destination, amount_raw, status, block_hash, idempotency_key, created_at, published_at, confirmed_at)
        VALUES (@id, @account_id, @destination, @amount_raw, @status, @block_hash, @idempotency_key, @created_at, @published_at, @confirmed_at)
      `).run({
        id: send.id,
        account_id: send.accountId,
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

    async listByAccount(accountId: string): Promise<Send[]> {
      const rows = db.prepare('SELECT * FROM sends WHERE account_id = ? ORDER BY created_at DESC').all(accountId) as Record<string, unknown>[];
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
          account_id = @account_id, destination = @destination, amount_raw = @amount_raw,
          status = @status, block_hash = @block_hash, idempotency_key = @idempotency_key,
          created_at = @created_at, published_at = @published_at, confirmed_at = @confirmed_at
        WHERE id = @id
      `).run({
        id: updated.id,
        account_id: updated.accountId,
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

function rowToEvent(row: Record<string, unknown>): RaiFlowEvent {
  return {
    id: row.id as string,
    type: row.type as string,
    timestamp: row.timestamp as string,
    data: JSON.parse(row.data as string) as Record<string, unknown>,
    resourceId: row.resource_id as string,
    resourceType: row.resource_type as RaiFlowEvent['resourceType'],
  };
}

export function createSqliteEventStore(db: Database): EventStore {
  return {
    async append(event: RaiFlowEvent): Promise<void> {
      db.prepare(`
        INSERT INTO events (id, type, timestamp, resource_id, resource_type, data)
        VALUES (@id, @type, @timestamp, @resource_id, @resource_type, @data)
      `).run({
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        resource_id: event.resourceId,
        resource_type: event.resourceType,
        data: JSON.stringify(event.data),
      });
    },

    async list(options?: EventQueryOptions): Promise<RaiFlowEvent[]> {
      const limit = options?.limit ?? 100;
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options?.after) {
        conditions.push('id > ?');
        params.push(options.after);
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
      const sql = `SELECT * FROM events ${where} ORDER BY id ASC LIMIT ${limit + 1}`;
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
