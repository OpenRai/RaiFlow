#!/usr/bin/env node

import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { RaiFlowClient } from '@openrai/raiflow-sdk';
import { startDurableEventConsumer } from '../shared/durable-event-consumer.mjs';
import { xnoDisplay, xnoToRaw } from '../shared/nano-utils.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const recentEvents = [];
let eventConsumer;

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

function accountEvents(account, source = recentEvents) {
  return source.filter((event) => {
    const data = event.data ?? {};
    return event.resourceId === account.id
      || data.account?.id === account.id
      || data.deposit?.recipientAccount === account.address
      || data.send?.source?.accountId === account.id;
  }).slice(-10).reverse();
}

async function renderAccountState(account, message = '') {
  const client = getClient();
  const [{ data: deposits }, { data: sends }] = await Promise.all([
    client.accounts.listDeposits(account.id),
    client.sends.listByAccount(account.id),
  ]);
  const persistedEvents = await eventConsumer?.getRecentEvents().catch(() => []);
  const events = accountEvents(account, persistedEvents?.length ? persistedEvents : recentEvents);
  return `<section id="account-state">
    <h2>Customer deposit account</h2>
    <p>Stable customer reference: <code>${escapeHtml(account.accountKey)}</code></p>
    <p>Address: <code>${escapeHtml(account.address)}</code></p>
    <p>Latest runtime balance: ${escapeHtml(xnoDisplay(account.balanceRaw))} XNO</p>
    ${message ? `<p role="status">${escapeHtml(message)}</p>` : ''}
    <h3>Withdraw</h3>
    <form hx-post="/customers/${encodeURIComponent(account.accountKey)}/withdrawals" hx-target="#account-state" hx-swap="outerHTML">
      <label>Destination Nano address <input name="destination" required autocomplete="off"></label>
      <label>Amount (XNO) <input name="amount" required inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,30})?"></label>
      <label>Request reference <input name="requestId" required value="${randomUUID()}"></label>
      <button type="submit">Queue withdrawal</button>
    </form>
    <h3>Confirmed deposits</h3>
    ${deposits.length ? `<ul>${deposits.map((deposit) => `<li>${escapeHtml(xnoDisplay(deposit.amountRaw))} XNO · ${escapeHtml(deposit.disposition)} · ${escapeHtml(deposit.blockHash)}</li>`).join('')}</ul>` : '<p>No confirmed deposits yet.</p>'}
    <h3>Withdrawals</h3>
    ${sends.length ? `<ul>${sends.map((send) => `<li>${escapeHtml(xnoDisplay(send.amountRaw))} XNO · ${escapeHtml(send.status)} · ${escapeHtml(send.id)}</li>`).join('')}</ul>` : '<p>No withdrawals yet.</p>'}
    <h3>Durable runtime events</h3>
    ${events.length ? `<ul>${events.map((event) => `<li>${escapeHtml(event.type)} · ${escapeHtml(event.timestamp)}</li>`).join('')}</ul>` : '<p>Waiting for account events.</p>'}
  </section>`;
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(join(directory, 'public')));

app.post('/customers', async (req, res) => {
  const accountKey = String(req.body.accountKey ?? '').trim();
  if (!accountKey || accountKey.length > 120) {
    res.status(400).send('<p role="alert">Enter a customer reference between 1 and 120 characters.</p>');
    return;
  }
  try {
    const account = await getClient().accounts.createManaged({
      accountKey,
      idempotencyKey: `customer-deposit:${accountKey}`,
    });
    res.status(200).send(await renderAccountState(account));
  } catch (error) {
    res.status(502).send(`<p role="alert">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
  }
});

app.post('/customers/:accountKey/withdrawals', async (req, res) => {
  const accountKey = String(req.params.accountKey);
  const destination = String(req.body.destination ?? '').trim();
  const amount = String(req.body.amount ?? '').trim();
  const requestId = String(req.body.requestId ?? '').trim();
  try {
    const client = getClient();
    const account = await client.accounts.createManaged({ accountKey, idempotencyKey: `customer-deposit:${accountKey}` });
    if (!requestId || requestId.length > 120) throw new Error('A withdrawal request reference is required.');
    const send = await client.sends.queue(account.id, {
      destination,
      amountRaw: xnoToRaw(amount),
      idempotencyKey: `withdrawal:${accountKey}:${requestId}`,
    });
    res.status(200).send(await renderAccountState(account, `Withdrawal ${send.id} is ${send.status}.`));
  } catch (error) {
    res.status(400).send(`<section id="account-state"><p role="alert">${escapeHtml(error instanceof Error ? error.message : String(error))}</p><a href="/">Return to customer lookup</a></section>`);
  }
});

const server = app.listen(PORT, () => console.log(`[customer-deposit-demo] http://localhost:${PORT}`));
try {
  eventConsumer = startDurableEventConsumer({
    client: getClient(),
    cursorFile: resolve(directory, '.raiflow/event-cursors.json'),
    consumerKey: 'customer-deposit-demo',
    onEvent(event) {
      recentEvents.push(event);
      if (recentEvents.length > 500) recentEvents.splice(0, recentEvents.length - 500);
    },
    onError(error) { console.error('[event-consumer]', error); },
  });
} catch (error) {
  console.error('[event-consumer]', error instanceof Error ? error.message : String(error));
}

process.on('SIGTERM', () => {
  eventConsumer?.stop();
  server.close();
});
