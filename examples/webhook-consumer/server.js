#!/usr/bin/env node
// =============================================================================
// RaiFlow Webhook Consumer Example
// =============================================================================
//
// Demonstrates how to receive and verify RaiFlow webhook events using
// @openrai/raiflow-sdk and @openrai/webhook (via re-export).
//
// This example registers itself as a webhook endpoint with the RaiFlow runtime,
// then acts as an HTTP server receiving events from the runtime.

import express from 'express';

import { RaiFlowClient, verifySignature } from '@openrai/raiflow-sdk';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const RAIFLOW_URL = process.env.RAIFLOW_URL ?? 'http://localhost:3100';

// The secret used when registering the webhook. The runtime stores this and
// includes it in the X-RaiFlow-Signature header on every delivery.
// For demo purposes we use a fixed secret. In production, generate randomly.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? 'demo-webhook-secret-change-me';

// =============================================================================
// SDK client
// =============================================================================

const raiflow = RaiFlowClient.initialize({ baseUrl: RAIFLOW_URL });

// =============================================================================
// In-memory event log (for display)
// =============================================================================

const eventLog = [];
const MAX_LOG = 100;

function logEvent(event, source) {
  eventLog.unshift({ ...event, _source: source, _receivedAt: new Date().toISOString() });
  if (eventLog.length > MAX_LOG) eventLog.pop();
}

// =============================================================================
// Express app
// =============================================================================

const app = express();

// Capture raw body before JSON parsing (needed for signature verification)
app.use('/webhooks', express.text({ type: 'application/json' }));
app.use(express.json());

// GET / — event log UI
app.get('/', (_req, res) => {
  const rows = eventLog.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#666">No events received yet</td></tr>'
    : eventLog.map((e) => `
        <tr>
          <td><span class="badge badge-${e.type.split('.')[0]}">${e.type}</span></td>
          <td><code>${e.id.slice(0, 8)}…</code></td>
          <td>${e._source}</td>
          <td>${new Date(e._receivedAt).toLocaleTimeString()}</td>
        </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RaiFlow Webhook Consumer</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 3rem auto; padding: 0 1rem; background: #0f0f0f; color: #e0e0e0; }
    h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
    p { color: #888; margin-bottom: 2rem; font-size: 0.875rem; }
    .meta { display: flex; gap: 2rem; margin-bottom: 2rem; padding: 1rem; background: #1a1a1a; border-radius: 6px; font-size: 0.875rem; }
    .meta-item { display: flex; flex-direction: column; gap: 0.25rem; }
    .meta-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #666; }
    .meta-value { font-family: monospace; color: #60a5fa; }
    .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .badge-invoice { background: #1e3a5f; color: #60a5fa; }
    .badge-payment { background: #14532d; color: #4ade80; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #666; padding: 0.5rem 1rem; border-bottom: 1px solid #2a2a2a; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #1a1a1a; font-size: 0.875rem; }
    tr:last-child td { border-bottom: none; }
    code { font-size: 0.8rem; color: #a1a1aa; }
    .refresh { font-size: 0.75rem; color: #666; margin-top: 1rem; }
    a { color: #60a5fa; }
  </style>
</head>
<body>
  <h1>RaiFlow Webhook Consumer</h1>
  <p>
    This server receives and verifies RaiFlow webhook events.<br>
    <a href="/health">Health check</a> · <a href="/webhooks">Registered webhooks</a>
  </p>

  <div class="meta">
    <div class="meta-item">
      <span class="meta-label">Listening on</span>
      <span class="meta-value">http://localhost:${PORT}/webhooks</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Runtime</span>
      <span class="meta-value">${RAIFLOW_URL}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">Events received</span>
      <span class="meta-value">${eventLog.length}</span>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Event</th>
        <th>Event ID</th>
        <th>Source</th>
        <th>Received</th>
      </tr>
    </thead>
    <tbody id="log-body">
      ${rows}
    </tbody>
  </table>
  <p class="refresh">Auto-refreshes every 5 seconds.</p>
  <script>setTimeout(() => location.reload(), 5000);</script>
</body>
</html>`);
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT });
});

// GET /webhooks — show registered webhooks
app.get('/webhooks', async (_req, res) => {
  try {
    const { data: endpoints } = await raiflow.webhooks.list();
    res.json({ endpoints });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /webhooks — receive and verify webhook events from the runtime
app.post('/webhooks', (req, res) => {
  const signature = req.headers['x-raiflow-signature'];
  const rawBody = req.body;

  // Verify the signature using the secret we registered with
  const isValid = verifySignature(rawBody, signature ?? '', WEBHOOK_SECRET);

  if (!isValid) {
    console.warn('[webhook] Signature verification FAILED');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  console.log(`[webhook] Received event: ${event.type} (${event.id})`);
  logEvent(event, 'webhook');

  // Handle the event — in a real app you'd dispatch to your business logic here
  switch (event.type) {
    case 'invoice.created':
      console.log(`  → Invoice ${event.data.invoice.id} created`);
      break;
    case 'payment.confirmed':
      console.log(`  → Payment ${event.data.payment.id} confirmed (${event.data.payment.amountRaw} raw)`);
      break;
    case 'invoice.completed':
      console.log(`  → Invoice ${event.data.invoice.id} completed!`);
      break;
    case 'invoice.expired':
      console.log(`  → Invoice ${event.data.invoice.id} expired`);
      break;
    case 'invoice.canceled':
      console.log(`  → Invoice ${event.data.invoice.id} canceled`);
      break;
    default:
      console.log(`  → Unknown event type: ${event.type}`);
  }

  // Always respond 2xx quickly to acknowledge receipt
  res.status(204).end();
});

// =============================================================================
// Startup
// =============================================================================

async function main() {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════╗');
  console.log('  ║      RaiFlow Webhook Consumer             ║');
  console.log('  ╚═══════════════════════════════════════════╝');
  console.log('');

  // Register this server as a webhook endpoint with the runtime
  const webhookUrl = `http://localhost:${PORT}/webhooks`;

  console.log(`[consumer] Registering webhook: ${webhookUrl}`);
  console.log(`[consumer] Using secret: ${WEBHOOK_SECRET}`);
  console.log(`[consumer] Pointing to runtime: ${RAIFLOW_URL}`);
  console.log('');

  try {
    const { data: existingEndpoints } = await raiflow.webhooks.list();
    const existing = existingEndpoints.find((endpoint) =>
      endpoint.url === webhookUrl && endpoint.secret === WEBHOOK_SECRET,
    );

    const endpoint = existing ?? await raiflow.webhooks.create({
      url: webhookUrl,
      eventTypes: [
        'invoice.created',
        'payment.confirmed',
        'invoice.completed',
        'invoice.expired',
        'invoice.canceled',
      ],
      secret: WEBHOOK_SECRET,
    });
    console.log(`[consumer] ✓ Webhook registered (id: ${endpoint.id})`);
    console.log(`[consumer]   Secret: ${endpoint.secret}`);
    console.log(`[consumer]   URL:    ${endpoint.url}`);
    console.log('');
    console.log(`[server]    Listening on http://localhost:${PORT}`);
    console.log(`[server]    Open http://localhost:${PORT} to view the event log`);
    console.log('');
    console.log('  NOTE: For this webhook to receive events from a remote runtime,');
    console.log('  this server must be publicly accessible. Use ngrok:');
    console.log(`    ngrok http ${PORT}`);
    console.log('  Then use the ngrok HTTPS URL when registering the webhook.');
    console.log('');
  } catch (err) {
    console.error('[consumer] Failed to register webhook:', err instanceof Error ? err.message : String(err));
    console.error('[consumer] Make sure the RaiFlow runtime is running at', RAIFLOW_URL);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log('[server] Ready to receive webhook events');
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
