# External Wallet Checkout Example

This Next.js example creates one-time Nano payment requests for an order. The
customer pays from any Nano wallet. The checkout browser never receives the
RaiFlow API key or controls wallet keys.

Set these server-side variables in `.env.local`:

```dotenv
RAIFLOW_URL=http://localhost:3100
RAIFLOW_API_KEY=your-runtime-api-key
```

Run the example:

```bash
cd examples/next-checkout
pnpm install
pnpm dev
```

Open `http://localhost:3003`, enter an order reference and XNO amount, then pay
the displayed address from an external wallet. The order reference is used as
the stable `invoiceKey`; `checkout:<orderId>` is the idempotency key. Repeating
the create request returns the same invoice.

The status page replays the durable global event sequence using an `after`
cursor stored in browser local storage. It calls the server's Next.js routes,
which use the SDK and keep the runtime credential private. Partial deposits keep
the invoice open; excess and late deposits are shown for review and must not
trigger automatic fulfillment.
