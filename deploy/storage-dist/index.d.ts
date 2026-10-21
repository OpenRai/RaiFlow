import type { InvoiceAccountStore, InvoiceStore, PaymentStore, AccountStore, SendStore, ReceiveTaskStore, EventStore, WebhookEndpointStore, IdempotencyReplayStore } from '@openrai/model';
import BetterSqlite3 from 'better-sqlite3';
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
export declare const SCHEMA_VERSION = 3;
export declare function createDatabase(path: string): Database;
export declare function createMigrationRunner(db: Database): MigrationRunner;
export declare function createSqliteInvoiceStore(db: Database): InvoiceStore;
export declare function createSqliteInvoiceAccountStore(db: Database): InvoiceAccountStore;
export declare function createSqliteReceiveTaskStore(db: Database): ReceiveTaskStore;
export declare function createSqlitePaymentStore(db: Database): PaymentStore;
export declare function createSqliteAccountStore(db: Database): AccountStore;
export declare function createSqliteSendStore(db: Database): SendStore;
export declare function createSqliteEventStore(db: Database): EventStore;
export declare function createSqliteWebhookStore(db: Database): WebhookEndpointStore;
export declare function createSqliteIdempotencyReplayStore(db: Database): IdempotencyReplayStore;
