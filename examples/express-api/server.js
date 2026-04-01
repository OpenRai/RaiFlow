#!/usr/bin/env node
// =============================================================================
// RaiFlow Express API Example
// =============================================================================
//
// Demonstrates @openrai/raiflow-sdk.
//
// All RaiFlow interaction goes through the SDK — no raw HTTP to the runtime.

import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RaiFlowClient } from '@openrai/raiflow-sdk';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT ?? '3002', 10);
const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';
const DEFAULT_RECIPIENT_ACCOUNT =
  process.env.RAIFLOW_RECIPIENT_ACCOUNT ??
  'nano_3strnmn7h9b7oghxa6h9ckrpf5r454fsobpicixps6xwiwc5q4hat7wjbpqz';

// =============================================================================
// SDK client
// =============================================================================

const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

// =============================================================================
// XNO → raw conversion (simple, no external deps)
// =============================================================================
//
// 1 XNO = 10^30 raw. Accepts strings like "1.5" or "0.001".

const RAW_PER_XNO = 1_000_000_000_000_000_000_000_000_000n; // 10^30

function xnoToRaw(xno) {
  const s = String(xno).trim();
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  const padded = (fracPart + '0'.repeat(30)).slice(0, 30);
  return (BigInt(intPart) * RAW_PER_XNO + BigInt(padded)).toString();
}

function truncateAddress(addr) {
  if (!addr || addr.length < 20) return addr ?? '?';
  return addr.slice(0, 13) + '…' + addr.slice(-6);
}

function truncateId(id) {
  return id.length > 8 ? id.slice(0, 8) + '…' : id;
}

function xnoDisplay(raw) {
  const n = BigInt(raw);
  const intPart = n / RAW_PER_XNO;
  const fracPart = (n % RAW_PER_XNO).toString().padStart(30, '0').replace(/0+$/, '');
  if (fracPart === '') return intPart.toString();
  return `${intPart}.${fracPart}`.replace(/\.$/, '');
}

// =============================================================================
// SSE client — polls runtime and pushes new events to browser
// =============================================================================

const activeSSEStreams = new Map(); // invoiceId → Set<{ res }>

async function pollEvents(invoiceId, afterEventId) {
  try {
    const { data: events } = await raiflow.invoices.listEvents(invoiceId, {
      after: afterEventId,
    });
    return events;
  } catch {
    return [];
  }
}

async function startSSEProducer(invoiceId) {
  let lastEventId = undefined;

  while (activeSSEStreams.has(invoiceId)) {
    const events = await pollEvents(invoiceId, lastEventId);
    if (events.length > 0) {
      lastEventId = events[events.length - 1].id;
      for (const res of activeSSEStreams.get(invoiceId) ?? []) {
        for (const event of events) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function addSSEClient(invoiceId, res) {
  if (!activeSSEStreams.has(invoiceId)) {
    activeSSEStreams.set(invoiceId, new Set());
    startSSEProducer(invoiceId).catch(() => {
      activeSSEStreams.delete(invoiceId);
    });
  }
  activeSSEStreams.get(invoiceId)?.add(res);
  res.on('close', () => {
    activeSSEStreams.get(invoiceId)?.delete(res);
  });
}

// =============================================================================
// Express app
// =============================================================================

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), 'public')));

// POST /invoices — create invoice and redirect to status page
app.post('/invoices', async (req, res) => {
  const { amount, policy, order_id, recipient_account } = req.body;

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    res.status(400).send('Invalid amount');
    return;
  }

  const raw = xnoToRaw(amount);
  const completionPolicy = policy === 'exact'
    ? { type: 'exact' }
    : { type: 'at_least' };

  const metadata = order_id ? { orderId: order_id } : undefined;
  const recipientAccount = String(recipient_account || DEFAULT_RECIPIENT_ACCOUNT).trim();

  try {
    const invoice = await raiflow.invoices.create({
      recipientAccount,
      expectedAmountRaw: raw,
      completionPolicy,
      metadata,
    });

    // Register webhook as well (backup event channel)
    try {
      await raiflow.webhooks.create({
        url: `http://localhost:${PORT}/webhooks`,
        eventTypes: [
          'invoice.created',
          'payment.confirmed',
          'invoice.completed',
          'invoice.expired',
          'invoice.canceled',
        ],
      });
    } catch {
      // Webhook registration may fail if already registered — that's fine
    }

    res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    res.status(500).send(`Failed to create invoice: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// GET /invoices/:id — invoice status page with SSE stream
app.get('/invoices/:id', async (req, res) => {
  const { id } = req.params;

  let invoice;
  try {
    invoice = await raiflow.invoices.get(id);
  } catch {
    res.status(404).send(`Invoice not found: ${id}`);
    return;
  }

  const amountDisplay = xnoDisplay(invoice.expectedAmountRaw);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${truncateId(invoice.id)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; background: #0f0f0f; color: #e0e0e0; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: #888; margin-bottom: 0.25rem; }
    .value { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; font-family: monospace; }
    .value.address { font-size: 1rem; word-break: break-all; }
    .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.875rem; font-weight: 600; }
    .badge-open { background: #1e3a5f; color: #60a5fa; }
    .badge-completed { background: #14532d; color: #4ade80; }
    .badge-expired { background: #7c2d12; color: #fb923c; }
    .badge-canceled { background: #3f3f46; color: #a1a1aa; }
    #event-log { list-style: none; padding: 0; margin: 0; }
    #event-log li { padding: 0.75rem 1rem; border-bottom: 1px solid #2a2a2a; font-size: 0.875rem; }
    #event-log li:last-child { border-bottom: none; }
    .event-type { font-weight: 600; color: #60a5fa; }
    .event-time { color: #666; font-size: 0.75rem; margin-left: 0.5rem; }
    .empty { color: #666; font-style: italic; }
    .nano-uri { font-size: 0.875rem; color: #60a5fa; word-break: break-all; }
    h1 { font-size: 1.25rem; margin-bottom: 1.5rem; }
    a { color: #60a5fa; }
    .hint { font-size: 0.875rem; color: #888; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Invoice <a href="/">← Back</a></h1>

  <div class="card">
    <div class="label">Status</div>
    <div class="value"><span class="badge badge-${invoice.status}">${invoice.status}</span></div>

    <div class="label">Send to this address</div>
    <div class="value address">${invoice.recipientAccount}</div>
    <div class="nano-uri">nano:${invoice.recipientAccount.replace('nano_', 'nano_')}</div>

    <div class="label">Amount</div>
    <div class="value">${amountDisplay} XNO</div>

    <div class="label">Policy</div>
    <div class="value" style="font-size:1rem; font-family:system-ui;">${invoice.completionPolicy?.type ?? 'at_least'}</div>

    <div class="label">Confirmed</div>
    <div class="value">${xnoDisplay(invoice.confirmedAmountRaw)} / ${amountDisplay} XNO</div>

    ${invoice.metadata?.orderId ? `<div class="label">Order ID</div><div class="value" style="font-size:1rem;">${invoice.metadata.orderId}</div>` : ''}
  </div>

  <div class="card">
    <div class="label">Live Events</div>
    <ul id="event-log">
      <li class="empty">Connecting…</li>
    </ul>
  </div>

  <script>
    const events = [];
    const log = document.getElementById('event-log');

    function formatEvent(event) {
      const time = new Date(event.createdAt).toLocaleTimeString();
      const type = event.type;
      let extra = '';
      if (type === 'invoice.created') extra = 'Invoice created';
      if (type === 'payment.confirmed') extra = \`Payment: \${event.data.payment.amountRaw} raw\`;
      if (type === 'invoice.completed') extra = 'Invoice completed!';
      if (type === 'invoice.expired') extra = 'Invoice expired';
      if (type === 'invoice.canceled') extra = 'Invoice canceled';
      return \`<span class="event-type">\${type}</span><span class="event-time">\${time}</span> — \${extra}\`;
    }

    function render() {
      if (events.length === 0) {
        log.innerHTML = '<li class="empty">No events yet. Send XNO to the address above.</li>';
        return;
      }
      log.innerHTML = events.map(e => \`<li>\${formatEvent(e)}</li>\`).join('');
    }

    // SSE connection for live events
    const es = new EventSource('/invoices/${invoice.id}/events');
    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      events.push(event);
      render();
    };
    es.onerror = () => {
      log.innerHTML = '<li class="empty">Connection lost. Refreshing…</li>';
      setTimeout(() => location.reload(), 3000);
    };
  </script>
</body>
</html>`);
});

// GET /invoices/:id/events — SSE stream of invoice events
app.get('/invoices/:id/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addSSEClient(req.params.id, res);
});

// POST /webhooks — receive events from runtime (backup channel)
app.post('/webhooks', express.json(), async (req, res) => {
  res.status(204).end();
});

// GET /webhooks — health check
app.get('/webhooks', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[raiflow] pointing to ${RAIFLOW_URL}`);
});
