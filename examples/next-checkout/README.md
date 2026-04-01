# Next.js Checkout Example

> **Status:** This example uses the prototype v1 API. It will be rebuilt against the v2 runtime.

A reference Next.js integration showing how to build a Nano payment checkout flow using the `@openrai/raiflow-sdk`.

## Prerequisites

- Node.js 20+
- pnpm
- RaiFlow runtime v2 running

## Running

```bash
cd examples/next-checkout
pnpm install
pnpm dev
```

Then open `http://localhost:3003` in your browser.

## What it demonstrates (prototype API)

- **Creating invoices** via `RaiFlowClient.invoices.create()` with XNO amounts and `exact` completion policy
- **Attaching metadata** — passing `orderId` as metadata so the invoice is tied to a specific order
- **Polling invoice state** via `GET /api/invoice/[id]`
- **Polling events** via `GET /api/invoice/[id]/events` with cursor-based polling
- **Reactive UI** — React state + `setInterval` polling to update the checkout page in real time

## v2 API migration

When the v2 runtime is complete, this example will be rebuilt to demonstrate:
- Invoice creation with automatic pay address derivation
- Managed wallet account integration
- Real-time payment detection via WebSocket subscriptions
- Auto-sweep to treasury on completion
