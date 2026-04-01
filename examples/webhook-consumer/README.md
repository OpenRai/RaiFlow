# Webhook Consumer Example

A reference implementation showing how to receive, verify, and handle RaiFlow webhook events using the `@openrai/raiflow-sdk`.

## Prerequisites

- Node.js 20+
- pnpm
- RaiFlow runtime running (`pnpm --filter @openrai/runtime start`)

## Running

```bash
cd examples/webhook-consumer
pnpm install
pnpm start
```

Then open `http://localhost:3001` to see the event log.

## What it demonstrates

- **Webhook registration** via `RaiFlowClient.webhooks.create()` — tells the runtime which URL to call
- **Signature verification** via `verifySignature()` — HMAC-SHA256 timing-safe verification of incoming events
- **Event routing** — switch on `event.type` to dispatch to business logic
- **Event log** — in-memory store of received events displayed as an HTML page

## How it works

1. On startup, the consumer registers `http://localhost:3001/webhooks` as an endpoint with the RaiFlow runtime
2. When the runtime has an event (e.g. a payment is confirmed), it POSTs to that URL
3. The consumer verifies the `X-RaiFlow-Signature` header using `verifySignature()`
4. The event is logged and dispatched to a switch handler

## Testing with a real runtime

For this consumer to receive events from a runtime not running on `localhost`, you need a **publicly accessible URL**. Two options:

### Option 1 — ngrok (recommended for development)

```bash
# In a separate terminal:
ngrok http 3001
```

Copy the `https://*.ngrok.io` URL. Either:
- Pass it when registering: set `WEBHOOK_URL=https://*.ngrok.io` before running, or
- Manually register the webhook pointing to `https://*.ngrok.io/webhooks`

### Option 2 — webhook.site

1. Go to [webhook.site](https://webhook.site) and copy your unique URL
2. Use it to manually register a webhook with the runtime via `POST /webhooks`
3. View received events in the webhook.site dashboard

This skips the local consumer entirely — useful for quick manual testing.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port this server listens on |
| `RAIFLOW_URL` | `http://localhost:3100` | RaiFlow runtime base URL |
| `WEBHOOK_SECRET` | `demo-webhook-secret-change-me` | Secret used for HMAC signing |
