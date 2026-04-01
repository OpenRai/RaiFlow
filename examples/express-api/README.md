# Express API Example

A reference Express.js integration showing how to create RaiFlow invoices and stream live payment events using the `@openrai/raiflow-sdk`.

## Prerequisites

- Node.js 20+
- pnpm
- RaiFlow runtime running (`pnpm --filter @openrai/runtime start`)

## Running

```bash
cd examples/express-api
pnpm install
pnpm start
```

Then open `http://localhost:3002` in your browser.

## What it demonstrates

- **Creating invoices** via `RaiFlowClient.invoices.create()` with XNO amounts
- **Polling invoice state** via `RaiFlowClient.invoices.get()`
- **Streaming live events** via `RaiFlowClient.invoices.listEvents()` with SSE (Server-Sent Events)
- **Registering webhooks** via `RaiFlowClient.webhooks.create()` for push-based delivery
- **Completion policies** — `at_least` (default) and `exact` policy
- **Cursor-based event pagination** using the `after` parameter
- **Invoice metadata** — attaching arbitrary context (e.g. order IDs) to invoices

## How it works

1. Fill in an amount (XNO) on the landing page and click **Create Invoice**
2. The invoice is created with a Nano address to send funds to
3. The page redirects to `/invoices/:id` where you can watch the live event stream
4. Send XNO to the invoice's Nano address using any wallet
5. As the payment is confirmed, events appear in real time:
   - `payment.confirmed` — a matching payment was confirmed
   - `invoice.completed` — the invoice reached its completion threshold
