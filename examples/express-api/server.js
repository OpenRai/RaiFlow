#!/usr/bin/env node

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RaiFlowClient } from '@openrai/raiflow-sdk';

const directory = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT ?? '3002', 10);

function getClient() {
  const apiKey = process.env.RAIFLOW_API_KEY;
  if (!apiKey) throw new Error('Set RAIFLOW_API_KEY before starting this example.');
  return RaiFlowClient.initialize({
    baseUrl: process.env.RAIFLOW_URL ?? 'http://localhost:3100',
    apiKey,
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderAccount(account, deposits) {
  const addressJson = JSON.stringify(account.address).replace(/</g, '\\u003c');
  const accountId = escapeHtml(account.id);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Watched Nano address</title>
<style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;color:#222}code{overflow-wrap:anywhere}.deposit{padding:.7rem 0;border-bottom:1px solid #ddd}</style></head>
<body><h1>Watched address</h1><p>RaiFlow observes this address and records confirmed deposits. It cannot sign or spend from it.</p>
<p>Address: <code>${escapeHtml(account.address)}</code></p><p>Account ID: <code>${accountId}</code></p>
<h2>Confirmed deposits</h2><div id="deposits">${deposits.length
    ? deposits.map((deposit) => `<div class="deposit">${escapeHtml(deposit.amountRaw)} raw · ${escapeHtml(deposit.disposition)} · ${escapeHtml(deposit.blockHash)}</div>`).join('')
    : '<p>No confirmed deposits recorded yet.</p>'}</div>
<h2>Durable account events</h2><ol id="events"><li>Loading events…</li></ol>
<script>
  const accountId = ${JSON.stringify(account.id)};
  const address = ${addressJson};
  const cursorKey = 'raiflow-watched-cursor:' + accountId;
  const list = document.getElementById('events');
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(cursorKey) || '{}');
    for (const event of (Array.isArray(saved.events) ? saved.events : [])) {
      const row = document.createElement('li');
      row.textContent = new Date(event.timestamp).toLocaleString() + ' — ' + event.type;
      list.append(row);
    }
  } catch { localStorage.removeItem(cursorKey); }
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    const params = new URLSearchParams({ address });
    const after = saved.cursor;
    if (after) params.set('after', after);
    try {
      const response = await fetch('/api/accounts/' + encodeURIComponent(accountId) + '/events?' + params);
      if (!response.ok) return;
      const page = await response.json();
      const known = new Set((saved.events || []).map((event) => event.id));
      const events = [...(saved.events || []), ...page.data.filter((event) => !known.has(event.id))].slice(-100);
      for (const event of page.data) {
        if (known.has(event.id)) continue;
        const row = document.createElement('li');
        row.textContent = new Date(event.timestamp).toLocaleString() + ' — ' + event.type;
        list.append(row);
        while (list.children.length > 100) list.firstElementChild.remove();
      }
      if (page.nextCursor) {
        saved = { cursor: page.nextCursor, events };
        localStorage.setItem(cursorKey, JSON.stringify(saved));
      }
      if (list.children.length === 1 && list.firstElementChild.textContent === 'Loading events…') list.replaceChildren();
    } catch { /* Retry from the last saved sequence on the next poll. */ }
    finally { polling = false; }
  }
  void poll();
  setInterval(poll, 2000);
</script></body></html>`;
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(join(directory, 'public')));

app.post('/watch', async (req, res) => {
  const address = String(req.body.address ?? '').trim();
  try {
    const client = getClient();
    const account = await client.accounts.createWatched({
      address,
      idempotencyKey: `watch-address:${address}`,
    });
    const { data: deposits } = await client.accounts.listDeposits(account.id);
    res.status(200).send(renderAccount(account, deposits));
  } catch (error) {
    res.status(400).send(`<!doctype html><html><body><h1>Could not watch address</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><a href="/">Try again</a></body></html>`);
  }
});

app.get('/api/accounts/:id/events', async (req, res) => {
  try {
    const client = getClient();
    const account = await client.accounts.get(req.params.id);
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    const page = await client.events.list({ ...(after ? { after } : {}), limit: 100 });
    const address = account.address;
    const data = page.data.filter((event) => {
      const eventData = event.data ?? {};
      return event.resourceId === account.id
        || eventData.account?.id === account.id
        || eventData.account?.address === address
        || eventData.deposit?.recipientAccount === address;
    });
    const sequence = page.data[page.data.length - 1]?.sequence;
    res.status(200).json({
      data,
      nextCursor: page.nextCursor ?? (sequence === undefined ? after ?? null : String(sequence)),
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.listen(PORT, () => console.log(`[watched-payment-demo] http://localhost:${PORT}`));
