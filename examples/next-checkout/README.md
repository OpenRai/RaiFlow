# Next.js Checkout Example

A reference Next.js integration showing how to build a Nano payment checkout flow using the `@openrai/raiflow-sdk`.

## Prerequisites

- Node.js 20+
- pnpm
- RaiFlow runtime running (`pnpm --filter @openrai/runtime start`)

## Running

```bash
cd examples/next-checkout
pnpm install
pnpm dev
```

Then open `http://localhost:3003` in your browser.

## What it demonstrates

- **Creating invoices** via `RaiFlowClient.invoices.create()` with XNO amounts and `exact` completion policy
- **Attaching metadata** — passing `orderId` as metadata so the invoice is tied to a specific order
- **Polling invoice state** via `GET /api/invoice/[id]`
- **Polling events** via `GET /api/invoice/[id]/events` with cursor-based polling (`after` parameter)
- **Reactive UI** — React state + `setInterval` polling to update the checkout page in real time
- **Completion detection** — transitions from "waiting" to "complete" on `invoice.completed` events
- **Nano address display** — showing the recipient address for the user to send funds to

## How it works

1. User enters an amount on the landing page and submits
2. `POST /api/create-invoice` creates an invoice using `RaiFlowClient.invoices.create()`
3. The user is redirected to `/checkout/[id]` showing the invoice status
4. The page polls `GET /api/invoice/[id]/events` every 2 seconds
5. When the payment is confirmed and the invoice reaches `exact` completion, the page shows success

## Completion policy

This example uses `completionPolicy: { type: 'exact' }`. The invoice only transitions to `completed` when the confirmed amount **exactly equals** the expected amount. This is useful for checkout flows where you want to reject over- or under-payments.

Use `completionPolicy: { type: 'at_least' }` (the default) to accept any payment that meets or exceeds the expected amount.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `RAIFLOW_URL` | `http://localhost:3100` | RaiFlow runtime URL (server-side) |
| `NEXT_PUBLIC_RAIFLOW_URL` | `http://localhost:3100` | RaiFlow runtime URL (client-side polling) |
