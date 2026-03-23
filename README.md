# RaiFlow

**A Nano payment runtime**  
Built in public by **OpenRai**.

RaiFlow is a thin settlement and integration layer for Nano. It turns raw node RPC and block-lattice mechanics into a simpler application runtime for payment expectations, confirmed payment proofs, and event-driven integrations.

## Why RaiFlow exists

Nano has the base settlement properties internet-native payments need: fast finality, feeless transfer, and permissionless access.

What it lacks is a strong application-facing runtime.

Today, developers who want to accept XNO for real products often have to stitch together:
- node RPC polling
- confirmation tracking
- block/account interpretation
- payment matching
- metadata joins
- webhook delivery
- retry and idempotency logic

That is too raw.

RaiFlow exists to abstract the lattice, expose a ledger-like integration surface, and make Nano easier to ship for:
- micropayments
- pay-per-use APIs
- usage-based billing
- agent payments
- digital services
- machine-to-machine commerce

## Doctrine

RaiFlow begins with the smallest useful payment runtime for Nano.

### 1. Observe first
The first mode is keyless observation of incoming payments.  
RaiFlow should be useful before it holds or spends funds.

### 2. Confirmed payment first
A confirmed matching Nano transfer should become a first-class application object:
- who paid
- how much
- for what invoice / expectation
- with what send block hash
- with what timestamp and chain context

### 3. Events first
Applications should consume:
- `invoice.created`
- `payment.confirmed`
- `invoice.completed`
- `invoice.expired`
- `invoice.canceled`

Not raw node/block mechanics.

### 4. Off-chain business context
Business metadata belongs off-chain:
- customer IDs
- order IDs
- API request context
- usage records
- entitlement decisions

RaiFlow joins application context to payment events. It does not try to force business logic on-chain.

### 5. Idempotency everywhere
Payment systems are retry-heavy by nature.  
RaiFlow should treat idempotency as a default, not an afterthought.

### 6. Tiny public API
The first public surface should stay small.

Initial primitives:
- `Invoice`
- `Payment`
- `EventEnvelope`
- `WebhookEndpoint`

### 7. Custody later
Custodial spend flows may matter later:
- treasury movement
- payouts
- refunds
- auto-receive / wallet operation

But they are not the first product.

## Initial product shape

RaiFlow starts as an event-driven payment runtime for Nano.

A developer should be able to:
1. create a payment expectation
2. associate it with off-chain metadata
3. detect a matching incoming payment
4. receive a normalized confirmed payment proof
5. subscribe to reliable events or webhooks

That is the initial wedge.

## Monorepo structure

```text
apps/site          - documentation and public site
packages/model     - shared types and canonical schemas
packages/watcher   - chain observation and confirmation tracking
packages/runtime   - payment expectation + event runtime
packages/sdk-js    - JS/TS SDK
packages/webhook   - webhook signing and delivery helpers
examples/          - reference integrations
rfcs/              - design discussion and decision trail
```

## Status

RaiFlow is currently in early public formation.

The immediate goals are:
- freeze the core model
- publish doctrine and roadmap
- ship an observe-mode MVP
- prove that Nano payment integrations can feel product-shaped rather than protocol-shaped

## What RaiFlow is not

RaiFlow is not:
- a protocol fork
- a consensus change
- a new base-layer ledger
- an attempt to hide Nano
- a chain-wide rebrand

RaiFlow is application infrastructure for Nano.

## Read next

- [Roadmap](./ROADMAP.md)
- [`rfcs/`](./rfcs)

## Contributing

This project is being built in public.

If you want to help:
- open issues
- propose RFCs
- test examples
- challenge assumptions with concrete use cases
- help define the smallest useful runtime

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

MIT
