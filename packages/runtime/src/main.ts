#!/usr/bin/env node
// @openrai/runtime — Standalone server entry point
//
// Wires together: Watcher → Runtime → Webhook delivery → HTTP server
//
// Configuration via environment variables:
//   RAIFLOW_PORT          — HTTP port (default: 3100)
//   RAIFLOW_HOST          — HTTP host (default: 0.0.0.0)
//   NANO_RPC_URL          — Nano node RPC URL (required)
//   NANO_WS_URL           — Nano node WebSocket URL (optional; enables real-time mode)
//   RAIFLOW_ACCOUNTS      — Comma-separated Nano accounts to watch (optional at startup)
//   RAIFLOW_EXPIRY_MS     — Invoice expiry check interval in ms (default: 10000)
//   RAIFLOW_POLL_MS       — RPC poll interval in ms for polling mode (default: 5000)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Runtime } from './runtime.js';
import { createHandler } from './handler.js';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env['RAIFLOW_PORT'] ?? '3100', 10);
const HOST = process.env['RAIFLOW_HOST'] ?? '0.0.0.0';
const NANO_RPC_URL = process.env['NANO_RPC_URL'];
const NANO_WS_URL = process.env['NANO_WS_URL'];
const ACCOUNTS = (process.env['RAIFLOW_ACCOUNTS'] ?? '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);
const EXPIRY_MS = parseInt(process.env['RAIFLOW_EXPIRY_MS'] ?? '10000', 10);
const POLL_MS = parseInt(process.env['RAIFLOW_POLL_MS'] ?? '5000', 10);

// ---------------------------------------------------------------------------
// Runtime setup
// ---------------------------------------------------------------------------

const runtime = new Runtime({ expiryIntervalMs: EXPIRY_MS });
runtime.start();

const handle = createHandler(runtime);

// ---------------------------------------------------------------------------
// Watcher setup (lazy — only if NANO_RPC_URL is configured)
// ---------------------------------------------------------------------------

let watcher: { start(): void; stop(): void } | undefined;

async function setupWatcher() {
  if (!NANO_RPC_URL) {
    console.log('[raiflow] NANO_RPC_URL not set — watcher disabled (HTTP API only)');
    return;
  }

  // Dynamic import to avoid hard dependency in library usage
  const { Watcher } = await import('@openrai/watcher');

  const w = new Watcher({
    rpcUrl: NANO_RPC_URL,
    wsUrl: NANO_WS_URL,
    accounts: ACCOUNTS,
    sink: runtime,
    pollIntervalMs: POLL_MS,
  });

  w.start();
  watcher = w;

  const mode = NANO_WS_URL ? 'websocket' : 'polling';
  console.log(`[raiflow] watcher started (${mode}) — watching ${ACCOUNTS.length} account(s)`);
}

// ---------------------------------------------------------------------------
// HTTP server (Node built-in, adapts IncomingMessage → Request → Response)
// ---------------------------------------------------------------------------

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';

  // Read body for methods that may have one
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
  try {
    const webReq = await toWebRequest(req);
    const webRes = await handle(webReq);
    await sendWebResponse(webRes, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message, code: 'internal_error' } }));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  await setupWatcher();

  server.listen(PORT, HOST, () => {
    console.log(`[raiflow] runtime listening on http://${HOST}:${PORT}`);
    console.log('[raiflow] endpoints:');
    console.log('  GET    /health');
    console.log('  POST   /invoices');
    console.log('  GET    /invoices');
    console.log('  GET    /invoices/:id');
    console.log('  POST   /invoices/:id/cancel');
    console.log('  GET    /invoices/:id/payments');
    console.log('  GET    /invoices/:id/events');
    console.log('  POST   /webhooks');
    console.log('  GET    /webhooks');
    console.log('  DELETE /webhooks/:id');
  });
}

// Graceful shutdown
function shutdown() {
  console.log('\n[raiflow] shutting down...');
  watcher?.stop();
  runtime.stop();
  server.close(() => {
    console.log('[raiflow] goodbye');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[raiflow] failed to start:', err);
  process.exit(1);
});
