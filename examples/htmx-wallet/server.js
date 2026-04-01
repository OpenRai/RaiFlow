#!/usr/bin/env node

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RaiFlowClient } from '@openrai/raiflow-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';

const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

let runtimeOnline = false;
let lastHealthAt = null;

function formatRelativeTime(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function classifyInvoiceEvent(type) {
  if (type === 'invoice.completed') return 'spendable';
  if (type === 'invoice.canceled' || type === 'invoice.expired') return 'refunded';
  return 'receivable';
}

async function fetchRuntimeSnapshot() {
  const health = await raiflow.system.health();
  const [{ data: invoices }, { data: webhooks }] = await Promise.all([
    raiflow.invoices.list(),
    raiflow.webhooks.list(),
  ]);

  const sortedInvoices = [...invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentInvoices = sortedInvoices.slice(0, 8);

  const invoiceEvents = [];
  for (const invoice of recentInvoices) {
    const { data } = await raiflow.invoices.listEvents(invoice.id);
    for (const event of data) {
      invoiceEvents.push({
        ...event,
        invoiceId: invoice.id,
        orderLabel: invoice.metadata?.orderId ?? invoice.id.slice(0, 8),
      });
    }
  }

  invoiceEvents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return {
    health,
    invoices: sortedInvoices,
    webhooks,
    events: invoiceEvents.slice(0, 20),
  };
}

async function refreshHealth() {
  try {
    await raiflow.system.health();
    runtimeOnline = true;
    lastHealthAt = new Date().toISOString();
  } catch {
    runtimeOnline = false;
  }
}

setInterval(refreshHealth, 5000);

const app = express();
app.use(express.static(join(__dirname, 'public')));

app.get('/api/status', async (_req, res) => {
  await refreshHealth();
  res.send(
    runtimeOnline
      ? `<div class="status online">Upstream Online · checked ${formatRelativeTime(lastHealthAt)}</div>`
      : '<div class="status offline">Upstream Offline</div>',
  );
});

app.get('/api/summary', async (_req, res) => {
  try {
    const snapshot = await fetchRuntimeSnapshot();
    const open = snapshot.invoices.filter((invoice) => invoice.status === 'open').length;
    const completed = snapshot.invoices.filter((invoice) => invoice.status === 'completed').length;
    const canceled = snapshot.invoices.filter((invoice) => invoice.status === 'canceled').length;

    res.send(`
      <div class="balance-card">
        <h3>Invoice States</h3>
        <div class="balance-amount">${open}<span class="currency"> open</span></div>
        <div class="address-pill">${completed} completed · ${canceled} canceled/expired</div>
      </div>
      <div class="qr-card">
        <h3>Runtime Overview</h3>
        <div class="address-pill">${snapshot.webhooks.length} webhook endpoints configured</div>
        <div class="address-pill">${snapshot.events.length} recent invoice events cached</div>
        <div class="address-pill">${snapshot.invoices.length} invoices visible through current runtime surface</div>
      </div>
    `);
  } catch (err) {
    res.status(500).send(`<div class="empty-state">${err instanceof Error ? err.message : String(err)}</div>`);
  }
});

app.get('/api/connectivity', async (_req, res) => {
  try {
    const snapshot = await fetchRuntimeSnapshot();
    const rows = [
      {
        name: 'Runtime health',
        state: snapshot.health.status === 'ok' ? 'online' : 'offline',
        detail: `GET /health · checked ${formatRelativeTime(lastHealthAt ?? new Date().toISOString())}`,
      },
      {
        name: 'Webhook endpoints',
        state: snapshot.webhooks.length > 0 ? 'connecting' : 'offline',
        detail: `${snapshot.webhooks.length} endpoint(s) registered`,
      },
      {
        name: 'Invoice event stream',
        state: snapshot.events.length > 0 ? 'online' : 'connecting',
        detail: `${snapshot.events.length} recent events visible via invoice polling`,
      },
    ];

    res.send(rows.map((row) => `
      <tr>
        <td>${row.name}</td>
        <td><span class="tag ${row.state === 'online' ? 'spendable' : row.state === 'connecting' ? 'receivable' : 'refunded'}">${row.state}</span></td>
        <td>${row.detail}</td>
        <td>${new Date().toLocaleTimeString()}</td>
      </tr>
    `).join(''));
  } catch (err) {
    res.status(500).send(`<tr><td colspan="4" class="empty-state">${err instanceof Error ? err.message : String(err)}</td></tr>`);
  }
});

app.get('/api/events', async (_req, res) => {
  try {
    const snapshot = await fetchRuntimeSnapshot();

    if (snapshot.events.length === 0) {
      res.send('<tr><td colspan="4" class="empty-state">No events yet.</td></tr>');
      return;
    }

    res.send(snapshot.events.map((event) => `
      <tr>
        <td><span class="tag ${classifyInvoiceEvent(event.type)}">${event.type}</span></td>
        <td><span class="mono">${event.orderLabel}</span></td>
        <td>${new Date(event.createdAt).toLocaleTimeString()}</td>
        <td>${formatRelativeTime(event.createdAt)}</td>
      </tr>
    `).join(''));
  } catch (err) {
    res.status(500).send(`<tr><td colspan="4" class="empty-state">${err instanceof Error ? err.message : String(err)}</td></tr>`);
  }
});

app.get('/api/clients', async (_req, res) => {
  try {
    const snapshot = await fetchRuntimeSnapshot();

    if (snapshot.webhooks.length === 0) {
      res.send('<tr><td colspan="4" class="empty-state">No attached clients or webhook sinks visible yet.</td></tr>');
      return;
    }

    res.send(snapshot.webhooks.map((endpoint) => `
      <tr>
        <td><span class="mono">${endpoint.id.slice(0, 8)}</span></td>
        <td>${endpoint.url}</td>
        <td>${endpoint.eventTypes.join(', ')}</td>
        <td>${new Date(endpoint.createdAt).toLocaleTimeString()}</td>
      </tr>
    `).join(''));
  } catch (err) {
    res.status(500).send(`<tr><td colspan="4" class="empty-state">${err instanceof Error ? err.message : String(err)}</td></tr>`);
  }
});

app.listen(PORT, async () => {
  await refreshHealth();
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[raiflow] pointing to ${RAIFLOW_URL}`);
});
