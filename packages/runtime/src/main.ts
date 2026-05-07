#!/usr/bin/env node
// @openrai/runtime — Standalone server entry point
//
// Boots from raiflow.yml config, initializes SQLite via the storage package,
// and exposes the HTTP handler on the configured daemon host:port.
//
// Configuration via YAML file (default: ./raiflow.yml) or RAIFLOW_CONFIG_PATH env var.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
// Mode validation
// ---------------------------------------------------------------------------

if (!config.daemon.mode) {
  console.error(
    [
      '[raiflow] RAIFLOW_MODE is required. Set it to "custodial" or "non-custodial".',
      '  custodial:      RaiFlow manages keys, derives accounts, signs blocks, generates PoW.',
      '                  Requires RAIFLOW_CUSTODY_SEED and RAIFLOW_CUSTODY_REP.',
      '  non-custodial:  RaiFlow acts as a relay and monitor. All signing happens client-side.',
      '                  Some features (invoices, managed accounts, sends) are unavailable.',
    ].join('\n'),
  );
  process.exit(1);
}

const mode = config.daemon.mode;

// Custody auto-generation happens after dbPath is resolved (below).

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

logger.info(`starting in ${mode === 'custodial' ? 'CUSTODIAL' : 'NON-CUSTODIAL'} mode`);

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
// Custody auto-generation (custodial mode)
// ---------------------------------------------------------------------------

const DEFAULT_REPRESENTATIVE = 'nano_3kqdiqmqiojr1aqqj51aq8bzz5jtwnkmhb38qwf3ppngo8uhhzkdkn7up7rp';

if (mode === 'custodial' && !config.custody) {
  const seedPath = resolve(dirname(dbPath), 'custody-seed.txt');
  let seed: string;

  if (existsSync(seedPath)) {
    seed = readFileSync(seedPath, 'utf-8').trim();
    logger.info('custody seed loaded from', seedPath);
  } else {
    seed = randomBytes(32).toString('hex');
    const seedDir = dirname(seedPath);
    if (!existsSync(seedDir)) {
      mkdirSync(seedDir, { recursive: true });
    }
    writeFileSync(seedPath, seed, { encoding: 'utf-8', mode: 0o600 });
    logger.info('custody seed generated and saved to', seedPath);
  }

  config = {
    ...config,
    custody: {
      seed,
      representative: DEFAULT_REPRESENTATIVE,
    },
  };
  (globalThis as { __RAIFLOW_CONFIG__?: RaiFlowConfig }).__RAIFLOW_CONFIG__ = config;
  logger.info('using default representative', DEFAULT_REPRESENTATIVE);
}

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
// Startup Probe
// ---------------------------------------------------------------------------

const rpcUrls = config.nano.rpc;
if (rpcUrls.length === 0) {
  logger.warn('no nano RPC endpoints configured — runtime will operate in degraded mode');
} else {
  const results = await Promise.allSettled(
    rpcUrls.map(async (url) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      // Handle basic auth in URL
      let cleanUrl = url;
      try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password) {
          const credentials = btoa(`${parsed.username}:${parsed.password}`);
          headers['Authorization'] = `Basic ${credentials}`;
          parsed.username = '';
          parsed.password = '';
          cleanUrl = parsed.toString();
        }
      } catch {
        // Ignore URL parsing errors, fetch will catch them
      }

      const res = await fetch(cleanUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'version' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as any;
      if (!body.node_vendor) throw new Error('unexpected response shape');
      return { url, vendor: body.node_vendor };
    }),
  );

  const succeeded = results.filter((r): r is PromiseFulfilledResult<{ url: string; vendor: string }> => r.status === 'fulfilled');
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

  if (succeeded.length === 0) {
    for (let i = 0; i < rpcUrls.length; i++) {
      const result = results[i];
      const reason = result?.status === 'rejected'
        ? (result as PromiseRejectedResult).reason
        : 'unknown';
      logger.error(`RPC endpoint unreachable: ${rpcUrls[i]} — ${reason}`);
    }
    logger.error(
      'FATAL: all configured Nano RPC endpoints are unreachable. ' +
      'The runtime cannot operate without RPC access. Exiting.',
    );
    process.exit(1);
  }

  for (const s of succeeded) {
    logger.info(`RPC endpoint OK: ${s.value.url} (${s.value.vendor})`);
  }

  if (failed.length > 0) {
    for (let i = 0; i < rpcUrls.length; i++) {
      const result = results[i];
      if (result?.status === 'rejected') {
        const reason = (result as PromiseRejectedResult).reason;
        logger.warn(`RPC endpoint unreachable (degraded): ${rpcUrls[i]} — ${reason}`);
      }
    }
    logger.warn(`${failed.length}/${rpcUrls.length} RPC endpoints unreachable — operating in degraded mode`);
  }
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
  mode,
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
logger.info(`api key loaded from ${source}`);

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
const displayHost = host === '0.0.0.0' ? 'localhost' : host;

server.listen(port, host, () => {
  logger.info(`listening on http://${displayHost}:${port}`);
  logger.info(`  - Dashboard: http://${displayHost}:${port}/dashboard`);
  logger.info(`  - API:       http://${displayHost}:${port}/api`);
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
