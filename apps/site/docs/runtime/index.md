# RaiFlow Runtime

RaiFlow's runtime is the main output of the initiative — a thin settlement and integration layer for Nano.

It turns raw node RPC and block-lattice mechanics into a small set of application primitives:

- **`Invoice`** — a payment expectation with associated metadata
- **`Payment`** — a confirmed matching Nano transfer
- **`EventEnvelope`** — a typed application event
- **`WebhookEndpoint`** — a registered delivery target for events

## How it works

A developer creates an invoice. RaiFlow watches the Nano network for confirmed send blocks matching that invoice. When a match is found, a `payment.confirmed` event fires. When enough confirmed payments satisfy the invoice, an `invoice.completed` event fires.

That's the whole flow for the mainline use case.

```
create invoice → watch for payments → payment.confirmed → invoice.completed
```

## Operating modes

### Observe mode (first)

RaiFlow watches Nano accounts for incoming payments, matches them to invoices, and emits events. It does not hold or spend funds. No private keys required.

This is the first and default mode. See [RFC 0002](/rfcs/0002-observe-mode).

### Custodial mode (later)

Treasury movement, payouts, refunds, and auto-receive may be added later as an optional higher-trust mode. Not the first product.

## Design principles

1. **Observe first** — prove value before holding funds
2. **Confirmed payment first** — a confirmed send block is the first event that matters
3. **Events first** — applications consume events, not block choreography
4. **Tiny API first** — four primitives, five events, that's it
5. **Idempotency everywhere** — retries and partial failure are normal
6. **Off-chain business context** — orders, users, and entitlements stay in your app
7. **Custody later** — only when clearly justified

## Packages

| Package | Purpose |
|---------|---------|
| `@openrai/model` | Canonical types and schemas |
| `@openrai/watcher` | Chain observation and confirmation tracking |
| `@openrai/runtime` | Payment expectation + event runtime |
| `@openrai/sdk-js` | JS/TS SDK |
| `@openrai/webhook` | Webhook signing and delivery helpers |

## Next

- [Event model reference →](/runtime/model)
- [Code examples →](/runtime/examples)
