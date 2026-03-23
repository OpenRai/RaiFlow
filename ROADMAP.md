# RaiFlow Roadmap

RaiFlow is a community-built Nano payment runtime under the OpenRai umbrella.

Its job is simple:

> **Abstract the lattice. Expose a ledger. Ship micropayments.**

The roadmap is intentionally sequenced around one doctrine:

> **Observe first. Events first. Tiny API first. Custody later.**

---

## Design principles

### 1. Default to observation
The first useful version of RaiFlow should not require custody.  
It should detect and normalize incoming payments before it tries to move funds.

### 2. Treat payment proof as a first-class primitive
Applications need a stable object representing a confirmed incoming payment, not a pile of raw node responses.

### 3. Expose events, not block choreography
Most developers do not want to reason directly about block/account mechanics.  
They want invoices, confirmations, proofs, and webhook events.

### 4. Keep business context off-chain
Orders, usage records, customer IDs, and access decisions remain application concerns.

### 5. Idempotency is mandatory
Every create, match, emit, and deliver flow should be built assuming retries and partial failure.

### 6. Add custody only when it unlocks clear value
Payouts, treasury movement, refunds, and spend orchestration are later phases.

---

# Phase 0 — Public kickoff

## Goal
Create a public home for the project and fix the framing.

## Deliverables
- GitHub org: `openrai`
- Monorepo: `raiflow`
- root `README.md`
- root `ROADMAP.md`
- initial site
- issue templates
- Discussions enabled
- first public statement of doctrine

## Exit criteria
A developer can land on the repo and understand:
- what RaiFlow is
- why it exists
- what it will and will not do first

---

# Phase 1 — Freeze the model

## Goal
Define the smallest useful public contract.

## Deliverables
Canonical model for:
- `Invoice`
- `PaymentProof`
- `Event`
- `WebhookEndpoint`

Initial event vocabulary:
- `invoice.created`
- `payment.detected`
- `payment.confirmed`
- `invoice.completed`
- `invoice.expired`
- `webhook.delivery_failed`

RFCs:
- project framing
- observe-mode architecture
- event model and delivery semantics

## Exit criteria
The project has stable nouns and stable event names before heavy implementation begins.

---

# Phase 2 — Observe-mode MVP

## Goal
Ship the first genuinely useful runtime without holding private keys.

## Deliverables
- watch configured Nano accounts / addresses
- detect incoming transfers
- match transfers to payment expectations
- emit normalized payment events
- generate confirmed payment proofs
- attach off-chain metadata
- persist invoice / payment state
- basic webhook delivery

## Notes
This phase is intentionally non-custodial.  
The product must prove its value before wallet operation is added.

## Exit criteria
A developer can create an invoice, receive a payment, and get a reliable confirmation event without writing raw RPC plumbing.

---

# Phase 3 — JS/TS SDK and demos

## Goal
Make the observe-mode runtime easy to integrate.

## Deliverables
- `@openrai/sdk-js`
- typed client helpers
- webhook verification helpers
- reference Express integration
- reference Next.js checkout demo
- example webhook consumer
- docs for invoice lifecycle and event handling

## Exit criteria
A developer can copy a reference integration and get a real end-to-end payment flow working quickly.

---

# Phase 4 — Hardening and pilot integrations

## Goal
Make the runtime reliable enough for repeated real-world use.

## Deliverables
- retry-safe event delivery
- idempotency enforcement
- better persistence adapters
- more complete invoice state handling
- observability and logs
- deployment docs
- test coverage for matching and confirmation flows
- at least one or two pilot integrations

## Exit criteria
RaiFlow can support small production-like integrations with confidence.

---

# Phase 5 — Optional custodial spend mode

## Goal
Add a second operating mode only if clearly justified.

## Deliverables
Potential features:
- treasury wallet operation
- payouts
- refunds
- automated receive flows
- sweep / settlement helpers
- explicit hot-wallet mode

## Notes
Custody is not the default identity of RaiFlow.  
It is an optional higher-trust operating mode.

## Exit criteria
Custodial features are introduced with clear boundaries and do not bloat the core observe-mode product.

---

# Phase 6 — Ecosystem layer

## Goal
Turn RaiFlow from a useful implementation into a reusable ecosystem standard.

## Deliverables
- stable event and proof conventions
- broader SDK support
- integration guides for wallets and services
- interoperability guidance
- public examples of usage-based billing / agent payments / API monetization

## Exit criteria
RaiFlow becomes the obvious starting point for application-facing Nano payment integration.

---

# What success looks like

RaiFlow succeeds if it makes this sentence true:

> "Accepting Nano in an application feels like integrating a payment product, not reverse-engineering node RPC."

Concretely, success means:
- developers can create payment expectations in minutes
- confirmed payment proofs are easy to consume
- application events are reliable
- Nano becomes easier to use for micropayments and machine-scale billing
- more Nano applications ship because the integration surface becomes smaller and clearer

---

# What RaiFlow should avoid early

Do not let early scope drift into:
- exchange infrastructure
- generalized wallet products
- broad identity/auth platforms
- protocol redesign debates
- endless abstraction layers
- features that exist only because they sound "enterprise"

The first responsibility is narrow:

> **make incoming Nano payments easy to integrate**

---

# Immediate next steps

1. create the public repo
2. publish doctrine and roadmap
3. write the first three RFCs
4. define the canonical `Invoice`, `PaymentProof`, and `Event` schemas
5. implement observe-mode chain watching
6. prove the flow in one reference app
