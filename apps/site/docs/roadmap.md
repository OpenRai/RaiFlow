# Roadmap

A living checklist. Updated as work progresses.

---

## Phase 0 — Public kickoff

- [x] GitHub org and monorepo created
- [x] Root README with doctrine
- [x] ROADMAP published
- [x] Initial site live
- [x] Issue templates and Discussions enabled

---

## Phase 1 — Freeze the model

- [x] Canonical `Invoice` shape defined
- [x] Canonical `Payment` shape defined
- [x] Typed `EventEnvelope` defined
- [x] `WebhookEndpoint` defined
- [x] Event vocabulary frozen: `invoice.created`, `payment.confirmed`, `invoice.completed`, `invoice.expired`, `invoice.canceled`
- [x] RFC 0001 — Project framing
- [x] RFC 0002 — Observe mode architecture
- [x] RFC 0003 — Event model and delivery semantics

---

## Phase 2 — Observe-mode MVP

- [ ] Watch configured Nano accounts/addresses
- [ ] Detect incoming confirmed send blocks
- [ ] Match confirmed sends to open invoices
- [ ] Emit `payment.confirmed` events
- [ ] Emit `invoice.completed` events
- [ ] Handle invoice expiry (`invoice.expired`)
- [ ] Attach off-chain metadata to invoices
- [ ] Persist invoice and payment state
- [ ] Basic webhook delivery with HMAC-SHA256 signing
- [ ] At-least-once delivery with retry

---

## Phase 3 — SDK and demos

- [ ] `@openrai/sdk-js` typed client
- [ ] Webhook verification helper
- [ ] Reference Express integration
- [ ] Reference Next.js checkout demo
- [ ] Example webhook consumer

---

## Phase 4 — Hardening and pilot integrations

- [ ] Retry-safe event delivery
- [ ] Idempotency enforcement
- [ ] Persistence adapters
- [ ] Observability and structured logs
- [ ] Test coverage for matching and confirmation flows
- [ ] Deployment documentation
- [ ] At least one pilot integration

---

## Phase 5 — Optional custodial mode

- [ ] Treasury wallet operation
- [ ] Payouts
- [ ] Refunds
- [ ] Automated receive flows
- [ ] Explicit hot-wallet mode

Custody is not the default identity of RaiFlow. It is an optional higher-trust mode, added only when clearly justified.

---

## Phase 6 — Ecosystem layer

- [ ] Stable event and proof conventions
- [ ] Broader SDK support (Python, Go, etc.)
- [ ] Integration guides for wallets and services
- [ ] Public examples: usage-based billing, agent payments, API monetization
