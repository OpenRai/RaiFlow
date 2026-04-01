#!/usr/bin/env node
// ============================================================================
// RaiFlow HTMX Wallet Demo
// ============================================================================
//
// Demonstrates @openrai/nano-core and @openrai/raiflow-sdk.
//
// Uses ONLY our packages. If something doesn't exist yet in nano-core or
// raiflow-sdk, it throws — we do NOT fall back to raw nanocurrency or
// manual RPC calls. That would defeat the purpose of the example.
//
// What works today:
//   - NanoAddress: address validation, public key derivation
//   - NanoAmount: safe raw/nano conversion and arithmetic
//   - RaiFlowClient: initialized (HTTP methods are stubs)
//
// What needs to be built in nano-core:
//   - seed/key generation
//   - block creation & signing
//   - work generation
//   - RPC transport (NanoClient → account_info, process, etc.)
//
// This example will be updated as nano-core and raiflow-sdk gain features.
// ============================================================================

import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── @openrai/nano-core: type-safe address & amount primitives ──
import { NanoAddress, NanoAmount } from '@openrai/nano-core';

// ── @openrai/raiflow-sdk: typed client for RaiFlow runtime ──
import { RaiFlowClient } from '@openrai/raiflow-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';
const WALLET_FILE = join(__dirname, 'example-wallet-data.json');

// ============================================================================
// RaiFlow SDK client
// ============================================================================

const raiflow = RaiFlowClient.initialize({
  baseUrl: RAIFLOW_URL,
});

// ============================================================================
// Wallet Persistence Layer
// ============================================================================
// Simple JSON file persistence for the demo wallet. In production you would
// use an encrypted vault or HSM. The wallet file is .gitignored.
// ============================================================================

/**
 * Load wallet from disk, or throw explaining what needs to be built.
 *
 * Seed/key generation is not yet in @openrai/nano-core.
 * To use this demo, create example-wallet-data.json manually:
 *
 *   {
 *     "seed": "YOUR_HEX_SEED",
 *     "address": "nano_...",
 *     "publicKey": "...",
 *     "privateKey": "...",
 *     "index": 0
 *   }
 */
async function loadOrCreateWallet() {
  if (existsSync(WALLET_FILE)) {
    console.log('[wallet] Loading existing wallet from', WALLET_FILE);
    const raw = readFileSync(WALLET_FILE, 'utf-8');
    const data = JSON.parse(raw);

    // Validate using NanoAddress
    const addr = NanoAddress.parse(data.address);
    console.log('[wallet] Address:', addr.toString());
    return { ...data, address: addr.toString() };
  }

  throw new Error(
    'Wallet not found. @openrai/nano-core does not yet expose seed/key generation.\n' +
    'Create example-wallet-data.json manually, or implement NanoClient.hydrateWallet() in nano-core.'
  );
}

// ============================================================================
// Nano operations — ALL through @openrai/nano-core
// ============================================================================
// These functions will throw if the required nano-core feature isn't built yet.
// That's intentional — we'd rather show what's missing than fake it.
// ============================================================================

async function getAccountBalance(account) {
  // TODO: NanoClient should expose RPC transport (account_balance)
  throw new Error(
    'NanoClient RPC transport not yet implemented. ' +
    'Needed: NanoClient.initialize().getAccountBalance(account)'
  );
}

async function getReceivableBlocks(account) {
  // TODO: NanoClient should expose RPC transport (receivable)
  throw new Error(
    'NanoClient RPC transport not yet implemented. ' +
    'Needed: NanoClient.initialize().getReceivableBlocks(account)'
  );
}

async function receiveBlock(wallet, sendBlockHash, amountRaw) {
  // Validate inputs using nano-core primitives
  const addr = NanoAddress.parse(wallet.address);
  const amount = NanoAmount.fromRaw(amountRaw);

  // TODO: NanoClient should expose hydrateWallet().receive()
  throw new Error(
    'NanoClient.hydrateWallet().receive() not yet implemented. ' +
    'Needed: block creation, work generation, and RPC process call.'
  );
}

async function sendBlock(wallet, destinationAccount, amountRaw) {
  // Validate inputs using nano-core primitives
  const destAddr = NanoAddress.parse(destinationAccount);
  const amount = NanoAmount.fromRaw(amountRaw);

  // TODO: NanoClient should expose hydrateWallet().send()
  throw new Error(
    'NanoClient.hydrateWallet().send() not yet implemented. ' +
    'Needed: block creation, work generation, and RPC process call.'
  );
}

// ============================================================================
// Unit conversion (via NanoAmount)
// ============================================================================

function rawToNano(raw) {
  return NanoAmount.fromRaw(raw).nano;
}

function truncateAddress(addr) {
  if (!addr || addr.length < 20) return addr ?? '?';
  return addr.slice(0, 13) + '…' + addr.slice(-6);
}

// ============================================================================
// RaiFlow connection health check
// ============================================================================

let raiflowOnline = false;

async function checkRaiFlowHealth() {
  try {
    const res = await fetch(`${RAIFLOW_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.json();
    raiflowOnline = body?.status === 'ok';
  } catch {
    raiflowOnline = false;
  }
}

setInterval(checkRaiFlowHealth, 5000);

// ============================================================================
// In-memory transaction ledger
// ============================================================================

const transactions = new Map();

// ============================================================================
// Background poller
// ============================================================================

let wallet = null;
let isPolling = false;

async function pollForFundings() {
  if (!wallet || isPolling) return;
  isPolling = true;

  try {
    const receivable = await getReceivableBlocks(wallet.address);
    for (const { hash, amountRaw, source } of receivable) {
      if (transactions.has(hash)) continue;
      transactions.set(hash, { hash, amountRaw, sender: source, status: 'receivable' });

      try {
        const receiveHash = await receiveBlock(wallet, hash, amountRaw);
        const tx = transactions.get(hash);
        if (tx) { tx.status = 'spendable'; tx.receivedHash = receiveHash; }
      } catch (err) {
        console.error('[poll] Failed to receive block', hash, ':', err.message);
      }
    }
  } catch (err) {
    console.error('[poll] Error during funding poll:', err.message);
  } finally {
    isPolling = false;
  }
}

setInterval(pollForFundings, 4000);

// ============================================================================
// Express App
// ============================================================================

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

app.get('/api/status', (_req, res) => {
  res.send(raiflowOnline
    ? `<div class="status online">RaiFlow Online</div>`
    : `<div class="status offline">RaiFlow Offline</div>`);
});

app.get('/api/balance', async (_req, res) => {
  try {
    const { balance } = await getAccountBalance(wallet.address);
    const amount = NanoAmount.fromRaw(balance);
    res.send(`${amount.nano} <span class="currency">XNO</span>`);
  } catch (err) {
    res.send(`<span class="skeleton-text">${err.message}</span>`);
  }
});

app.get('/api/address', (_req, res) => {
  const addr = NanoAddress.parse(wallet.address);
  res.send(`
    <input type="hidden" id="nano-uri" value="nano:${addr.toString()}">
    <div class="address-pill">${addr.toString()}</div>
  `);
});

app.get('/api/events', (_req, res) => {
  if (transactions.size === 0) {
    res.send(`<tr><td colspan="4" class="empty-state">No transactions yet. Send XNO to the address above!</td></tr>`);
    return;
  }

  let html = '';
  for (const [hash, tx] of transactions) {
    const statusTag = tx.refundHash
      ? `<span class="tag refunded">Refunded</span>`
      : tx.status === 'spendable'
        ? `<span class="tag spendable">Spendable</span>`
        : `<span class="tag receivable">Receivable</span>`;

    const sender = truncateAddress(tx.sender);
    const amount = NanoAmount.fromRaw(tx.amountRaw);

    let actionHtml;
    if (tx.refundHash) {
      actionHtml = `<span class="mono" style="font-size:0.75rem">${truncateAddress(tx.refundHash)}</span>`;
    } else if (tx.status === 'spendable') {
      actionHtml = `
        <button class="btn"
          hx-post="/api/refund/${hash}"
          hx-target="#tx-table-body"
          hx-swap="innerHTML"
          hx-confirm="Send ${amount.nano} XNO back to ${sender}?"
        >Send back</button>`;
    } else {
      actionHtml = `<button class="btn disabled" disabled>Pending…</button>`;
    }

    html += `
      <tr>
        <td>${statusTag}</td>
        <td><span class="mono">${sender}</span></td>
        <td><span class="mono">${amount.nano}</span></td>
        <td>${actionHtml}</td>
      </tr>`;
  }
  res.send(html);
});

app.post('/api/refund/:hash', async (req, res) => {
  const tx = transactions.get(req.params.hash);
  if (!tx) { res.status(404).send('Transaction not found.'); return; }
  if (tx.refundHash) { res.status(409).send('Already refunded.'); return; }
  if (tx.status !== 'spendable') { res.status(400).send('Not yet spendable.'); return; }

  try {
    const refundHash = await sendBlock(wallet, tx.sender, tx.amountRaw);
    tx.refundHash = refundHash;
  } catch (err) {
    res.status(500).send(`Refund failed: ${err.message}`);
    return;
  }

  res.redirect(303, '/api/events');
});

// ============================================================================
// Startup
// ============================================================================

async function main() {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║       RaiFlow HTMX Wallet Demo           ║');
  console.log('  ║  Uses ONLY @openrai/nano-core + raiflow-sdk ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');

  wallet = await loadOrCreateWallet();

  await checkRaiFlowHealth();
  console.log(`[raiflow] ${RAIFLOW_URL} →`, raiflowOnline ? '✓ online' : '✗ offline');

  await pollForFundings();

  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
