#!/usr/bin/env node
// @openrai/runtime — Standalone server entry point
//
// Boots from raiflow.yml config, initializes SQLite via the storage package,
// and exposes the HTTP handler on the configured daemon host:port.
//
// Configuration via YAML file (default: ./raiflow.yml) or RAIFLOW_CONFIG_PATH env var.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type RaiFlowConfig } from '@openrai/config';
import { createDatabase, createMigrationRunner, createSqliteInvoiceStore, createSqlitePaymentStore, createSqliteAccountStore, createSqliteSendStore, createSqliteEventStore, createSqliteWebhookStore, type Database } from '@openrai/storage';
import { createEventBus, createPersistentEventStore } from '@openrai/events';
import { createRpcPool } from '@openrai/rpc';
import { createCustodyEngine } from '@openrai/custody';
import { Watcher } from '@openrai/watcher';
import { createHandler } from './handler.js';
import { Runtime } from './runtime.js';
import { createRuntimeMetrics } from './monitoring.js';
import { resolveApiKey } from './auth.js';
import {
  createLegacySqliteEventStore,
  createLegacySqliteInvoiceStore,
  createLegacySqlitePaymentStore,
} from './sqlite-legacy-adapters.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function findWorkspaceRoot(): string {
  // Walk up from this file (packages/runtime/dist/main.js) to find pnpm-workspace.yaml
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: current working directory
  return process.cwd();
}

const WORKSPACE_ROOT = findWorkspaceRoot();
const CONFIG_PATH = resolve(WORKSPACE_ROOT, process.env['RAIFLOW_CONFIG_PATH'] ?? 'raiflow.yml');

let config: RaiFlowConfig;
try {
  config = loadConfig(CONFIG_PATH);
  (globalThis as { __RAIFLOW_CONFIG__?: RaiFlowConfig }).__RAIFLOW_CONFIG__ = config;
} catch (err) {
  console.error(`[raiflow] failed to load config from ${CONFIG_PATH}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = config.logging.level;

function shouldLog(level: LogLevel): boolean {
  return LOG_PRIORITY[level] >= LOG_PRIORITY[currentLevel];
}

function log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0 ? `${message} ${args.map(String).join(' ')}` : message;
  const output = `[${timestamp}] [${level.toUpperCase()}] [${prefix}] ${formatted}`;
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

const logger = {
  debug: (msg: string, ...args: unknown[]) => log('debug', 'raiflow', msg, ...args),
  info: (msg: string, ...args: unknown[]) => log('info', 'raiflow', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log('warn', 'raiflow', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log('error', 'raiflow', msg, ...args),
};

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let db: Database;
let dbPath = '';
try {
  dbPath = resolve(WORKSPACE_ROOT, config.storage.path);
  db = createDatabase(dbPath);
  logger.info('sqlite open', dbPath);
} catch (err) {
  logger.error('failed to open database:', err instanceof Error ? err.message : err);
  process.exit(1);
}

// Run migrations
const migrationRunner = createMigrationRunner(db);
await migrationRunner.up();
const appliedMigrations = migrationRunner.getApplied();
logger.info('migrations applied', appliedMigrations.join(', '));

const metrics = createRuntimeMetrics({ dbPath, migrations: appliedMigrations });
(globalThis as { __RAIFLOW_METRICS__?: ReturnType<typeof createRuntimeMetrics> }).__RAIFLOW_METRICS__ = metrics;

// ---------------------------------------------------------------------------
// Stores (wire through events system)
// ---------------------------------------------------------------------------

const eventBus = createEventBus();
const sqliteInvoiceStore = createSqliteInvoiceStore(db);
const sqlitePaymentStore = createSqlitePaymentStore(db);
const eventStore = createPersistentEventStore(
  createSqliteEventStore(db),
  eventBus,
);
const invoiceStore = createLegacySqliteInvoiceStore(sqliteInvoiceStore);
const paymentStore = createLegacySqlitePaymentStore(sqlitePaymentStore, sqliteInvoiceStore);
const accountStore = createSqliteAccountStore(db);
const sendStore = createSqliteSendStore(db);
const webhookStore = createSqliteWebhookStore(db);
const legacyEventStore = createLegacySqliteEventStore(eventStore);

// ---------------------------------------------------------------------------
// RPC pool
// ---------------------------------------------------------------------------

let rpcPool = createRpcPool([]);
if (config.nano.rpc.length > 0 || config.nano.ws.length > 0 || config.nano.work.length > 0) {
  rpcPool = createRpcPool([{
    rpc: config.nano.rpc,
    ws: config.nano.ws,
    work: config.nano.work,
  }]);
  logger.info('rpc pool initialized', `rpc=${config.nano.rpc.length} ws=${config.nano.ws.length} work=${config.nano.work.length}`);
}

// ---------------------------------------------------------------------------
// Custody engine
// ---------------------------------------------------------------------------

let custodyEngine: ReturnType<typeof createCustodyEngine> | undefined;
if (config.custody) {
  custodyEngine = createCustodyEngine({
    seed: config.custody.seed,
    representative: config.custody.representative,
    derivationStartIndex: { invoice: 0, managed: 0 },
  });
  custodyEngine.loadSeed(config.custody.seed);
  logger.info('custody engine initialized');
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const runtime = new Runtime({
  invoiceStore: invoiceStore as any,
  paymentStore: paymentStore as any,
  eventStore: legacyEventStore as any,
  v2EventStore: eventStore,
  webhookEndpointStore: webhookStore as any,
  accountStore,
  sendStore,
  custodyEngine,
  rpcPool,
  expiryIntervalMs: 10_000,
});

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

const watcher = new Watcher({
  wsUrl: config.nano.ws[0],
  rpcUrl: config.nano.rpc[0],
  accounts: [],
  sink: runtime,
  pollIntervalMs: 5000,
});

// Seed watcher with existing accounts
const existingAccounts = await accountStore.list();
for (const acc of existingAccounts) {
  watcher.addAccount(acc.address);
}

runtime.watcher = watcher;
watcher.start();
logger.info('watcher started', `accounts=${existingAccounts.length}`);

runtime.start();
logger.info('runtime started');

// ---------------------------------------------------------------------------
// API Key
// ---------------------------------------------------------------------------

const { apiKey, source } = resolveApiKey(config);
if (source === 'config') {
  logger.info('api key loaded from config');
} else if (source === 'file') {
  logger.info('api key loaded from file');
} else {
  logger.info('api key auto-generated');
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const handle = createHandler(runtime, apiKey);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';

  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
    }
    body = Buffer.concat(chunks).toString('utf-8');
  }

  return new Request(url, {
    method,
    headers: Object.entries(req.headers).reduce<Record<string, string>>(
      (acc, [key, value]) => {
        if (typeof value === 'string') acc[key] = value;
        return acc;
      },
      {},
    ),
    body: body ?? null,
  });
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  const responseBody = await webRes.text();
  res.end(responseBody);
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestUrl = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  try {
    const webReq = await toWebRequest(req);
    const webRes = await handle(webReq);
    metrics.recordRequest({
      method: webReq.method,
      path: new URL(requestUrl).pathname,
      status: webRes.status,
      durationMs: Date.now() - startedAt,
    });
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    metrics.recordRequest({
      method: req.method ?? 'GET',
      path: new URL(requestUrl).pathname,
      status: 500,
      durationMs: Date.now() - startedAt,
    });
    logger.error('unhandled request error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message, code: 'internal_error' } }));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const { host, port } = config.daemon;
server.listen(port, host, () => {
  logger.info(`listening on http://${host}:${port}`);
});

// Graceful shutdown
function shutdown(): void {
  logger.info('shutting down...');
  runtime.stop();
  db.close();
  server.close(() => {
    logger.info('goodbye');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
