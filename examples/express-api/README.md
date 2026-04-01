# Express API Example

> **Status:** This example uses the prototype v1 API. It will be rebuilt against the v2 runtime.

A reference Express.js integration showing how to create RaiFlow invoices and stream live payment events using the `@openrai/raiflow-sdk`.

## Prerequisites

- Node.js 20+
- pnpm
- RaiFlow runtime v2 running

## Running

```bash
cd examples/express-api
pnpm install
pnpm start
```

Then open `http://localhost:3002` in your browser.

## What it demonstrates (prototype API)

- **Creating invoices** via `RaiFlowClient.invoices.create()` with XNO amounts
- **Polling invoice state** via `RaiFlowClient.invoices.get()`
- **Streaming live events** via SSE with cursor-based polling
- **Registering webhooks** via `RaiFlowClient.webhooks.create()`
- **Completion policies** — `at_least` (default) and `exact` policy

## v2 API migration

When the v2 runtime is complete, this example will be rebuilt to demonstrate:
- Wallet account creation and management
- Invoice creation with derived pay addresses
- Idempotent sends from managed accounts
- Pre-signed block publishing
