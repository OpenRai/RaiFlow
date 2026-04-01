#!/usr/bin/env node

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NanoAddress, NanoAmount } from '@openrai/nano-core';
import { RaiFlowClient } from '@openrai/raiflow-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';
const RECIPIENT_ACCOUNT =
  process.env.RAIFLOW_RECIPIENT_ACCOUNT ??
  'nano_3strnmn7h9b7oghxa6h9ckrpf5r454fsobpicixps6xwiwc5q4hat7wjbpqz';

const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

function xnoToRaw(xno) {
  const s = String(xno).trim();
  const dot = s.indexOf('.');
  const intPart = dot === -1 ? s : s.slice(0, dot);
  const fracPart = dot === -1 ? '' : s.slice(dot + 1);
  const padded = (fracPart + '0'.repeat(30)).slice(0, 30);
  return (BigInt(intPart) * 10n ** 30n + BigInt(padded)).toString();
}

function rawToNano(raw) {
  return NanoAmount.fromRaw(raw).nano;
}

let raiflowOnline = false;

async function listInvoices() {
  const { data } = await raiflow.invoices.list();
  return data.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function checkRaiFlowHealth() {
  try {
    await raiflow.webhooks.list();
    raiflowOnline = true;
  } catch {
    raiflowOnline = false;
  }
}

setInterval(checkRaiFlowHealth, 5000);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/status', async (_req, res) => {
  await checkRaiFlowHealth();
  res.send(
    raiflowOnline
      ? '<div class="status online">RaiFlow Online</div>'
      : '<div class="status offline">RaiFlow Offline</div>',
  );
});

app.get('/api/balance', async (_req, res) => {
  try {
    const invoices = await listInvoices();
    const openInvoices = invoices.filter((invoice) => invoice.status === 'open');
    const totalRaw = openInvoices.reduce(
      (sum, invoice) => sum + BigInt(invoice.expectedAmountRaw),
      0n,
    );
    res.send(`${rawToNano(totalRaw.toString())} <span class="currency">XNO pending</span>`);
  } catch (err) {
    res.send(`<span class="skeleton-text">${err instanceof Error ? err.message : String(err)}</span>`);
  }
});

app.get('/api/address', (_req, res) => {
  const addr = NanoAddress.parse(RECIPIENT_ACCOUNT);
  res.send(`
    <input type="hidden" id="nano-uri" value="nano:${addr.toString()}">
    <div class="address-pill">${addr.toString()}</div>
  `);
});

app.get('/api/events', async (_req, res) => {
  try {
    const invoices = await listInvoices();
    if (invoices.length === 0) {
      res.send('<tr><td colspan="4" class="empty-state">No invoices yet. Create one below.</td></tr>');
      return;
    }

    const rows = invoices.map((invoice) => {
      const statusClass = invoice.status === 'completed'
        ? 'spendable'
        : invoice.status === 'canceled'
          ? 'refunded'
          : 'receivable';

      const action = invoice.status === 'open'
        ? `<button class="btn" hx-post="/api/invoices/${invoice.id}/cancel" hx-target="#tx-table-body" hx-swap="innerHTML">Cancel</button>`
        : '<span class="mono" style="font-size:0.75rem">Closed</span>';

      return `
        <tr>
          <td><span class="tag ${statusClass}">${invoice.status}</span></td>
          <td><span class="mono">${invoice.metadata?.orderId ?? invoice.id.slice(0, 8)}</span></td>
          <td><span class="mono">${rawToNano(invoice.expectedAmountRaw)}</span></td>
          <td>${action}</td>
        </tr>`;
    }).join('');

    res.send(rows);
  } catch (err) {
    res.status(500).send(`<tr><td colspan="4" class="empty-state">${err instanceof Error ? err.message : String(err)}</td></tr>`);
  }
});

app.post('/api/invoices', async (req, res) => {
  const amount = String(req.body.amount ?? '').trim();
  const orderId = String(req.body.order_id ?? '').trim();

  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    res.status(400).send('Invalid amount');
    return;
  }

  try {
    await raiflow.invoices.create({
      recipientAccount: RECIPIENT_ACCOUNT,
      expectedAmountRaw: xnoToRaw(amount),
      metadata: orderId ? { orderId } : undefined,
    });
    res.redirect(303, '/api/events');
  } catch (err) {
    res.status(500).send(`Failed to create invoice: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.post('/api/invoices/:id/cancel', async (req, res) => {
  try {
    await raiflow.invoices.cancel(req.params.id);
    res.redirect(303, '/api/events');
  } catch (err) {
    res.status(500).send(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

app.listen(PORT, async () => {
  await checkRaiFlowHealth();
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[raiflow] pointing to ${RAIFLOW_URL}`);
  console.log(`[recipient] ${RECIPIENT_ACCOUNT}`);
});
