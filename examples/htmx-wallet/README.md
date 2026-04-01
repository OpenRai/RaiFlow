# HTMX Wallet Example

> **Status:** This example uses the prototype v1 API and `@openrai/nano-core`. It will be rebuilt against the v2 runtime.

A demonstration of the `@openrai/raiflow-sdk` and `@openrai/nano-core`. The backend uses Node.js (Express), and the frontend is powered by HTMX.

## Prerequisites

1. RaiFlow daemon running in a separate terminal
2. pnpm installed and the workspace built

## Running

```bash
cd examples/htmx-wallet
pnpm install
pnpm start
```

## What it demonstrates (prototype API)

- **Wallet Auto-Generation**: Generates and persists a local Nano seed into an `.gitignore`d `example-wallet-data.json`
- **RaiFlow Event Observation**: Subscribes to `payment.confirmed` events
- **HTMX Server-Side Rendering**: Reactive interface served via HTML fragments
- **nano-core Integration**: Uses `@openrai/nano-core` for key management and block construction

## v2 API migration

When the v2 runtime is complete, this example will be rebuilt to demonstrate:
- Managed account creation via `POST /v1/accounts`
- Send operations via `POST /v1/accounts/:id/send`
- Wallet domain: balance tracking, auto-receive, frontier management
- Pre-signed block publishing workflow
