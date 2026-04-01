# Examples

Examples are currently a migration area, not a polished source of truth.

## Current Situation

The example applications in the repository mostly target the earlier prototype runtime.

That means they may still be useful for understanding rough integration flow, but they should not be treated as authoritative documentation for the v2 runtime API or model.

## Existing Example Directories

- `examples/express-api/`
- `examples/next-checkout/`
- `examples/webhook-consumer/`
- `examples/htmx-wallet/`

## What To Expect

Until the examples are rebuilt, expect mismatches in:

- route names
- payload shapes
- event names
- custody behavior
- wallet-domain capabilities

## Planned Rebuilds

The intended replacement examples are:

| Example | Purpose |
|---|---|
| Express API | minimal server-side integration |
| Next.js Checkout | invoice creation and payment status UI |
| Webhook Consumer | receiving and verifying RaiFlow events |
| HTMX Wallet | wallet-domain flows and account operations |

For current truth, prefer the repository README, roadmap, and RFCs over the examples.
