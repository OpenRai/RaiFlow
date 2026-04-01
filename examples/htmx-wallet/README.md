# RaiFlow HTMX Demo Wallet

This is a beautiful, isomorphic demonstration of the `@openrai/raiflow-sdk` and `@openrai/nano-core`. The backend uses Node.js (Express), and the frontend is powered completely by HTMX without any heavy client-side JavaScript frameworks.

## Prerequisites

1. Have the RaiFlow daemon running in a separate terminal:
   ```bash
   # From the root of the monorepo where RaiFlow server is located
   pnpm run start
   ```
2. Have `pnpm` installed and the workspace built.

## Running the Demo

```bash
cd RaiFlow/examples/htmx-wallet
pnpm install
pnpm start
```

## Features Demonstrated

- **Isomorphic Core & JIT Profiling**: Uses `WorkProvider.auto()` through `@openrai/nano-core`.
- **Wallet Auto-Generation**: Generates and persists a local Nano seed into an `.gitignore`d `example-wallet-data.json`.
- **RaiFlow Event Observation**: Subscribes to RaiFlow's `payment.confirmed` events.
- **Fail-safe Idempotency**: Instantly refund confirmed payments back to the sender exactly as observed.
- **HTMX Server-Side Rendering**: Aesthetic, reactive interface directly served via HTML fragments.

## How it works

1. Opens port `3000`.
2. UI connects and polls `/api/events` via HTMX.
3. Every time a new fund-in is confirmed, it appears as "Spendable" with a "Send back" button.
4. Clicking "Send back" constructs a refund block and routes it through the nano-core Node RPC wrapper.
