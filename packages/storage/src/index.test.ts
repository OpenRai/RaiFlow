import { afterEach, describe, expect, it } from 'vitest';
import type { RaiFlowEvent } from '@openrai/model';
import {
  createDatabase,
  createMigrationRunner,
  createSqliteEventStore,
  SCHEMA_VERSION,
  type Database,
} from './index.js';

describe('v3 storage foundation', () => {
  let db: Database | undefined;

  afterEach(() => db?.close());

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

  it('refuses to mutate a pre-v3 database', () => {
    db = createDatabase(':memory:');
    db.exec('CREATE TABLE invoices (id TEXT PRIMARY KEY)');
    expect(() => createMigrationRunner(db!)).toThrow('predates RaiFlow v3');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_metadata'").get()).toBeUndefined();
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
});
