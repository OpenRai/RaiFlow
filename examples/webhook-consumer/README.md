# Webhook Consumer Example

> **Status:** This example uses the prototype v1 API. It will be rebuilt against the v2 runtime.

A reference implementation showing how to receive, verify, and handle RaiFlow webhook events.

## Prerequisites

- Node.js 20+
- pnpm
- RaiFlow runtime v2 running

## Running

```bash
cd examples/webhook-consumer
pnpm install
pnpm start
```

Then open `http://localhost:3001` to see the event log.

## What it demonstrates (prototype API)

- **Webhook registration** via `RaiFlowClient.webhooks.create()`
- **Signature verification** — HMAC-SHA256 timing-safe verification
- **Event routing** — switch on `event.type` to dispatch to business logic
- **Event log** — in-memory store of received events displayed as an HTML page

## v2 API migration

When the v2 runtime is complete, this example will be rebuilt to demonstrate:
- Webhook registration for the full v2 event vocabulary
- Signature verification for all v2 event types
- Global event polling via `GET /v1/events`
- WebSocket subscription handling
