# Roadmap

A living checklist. Updated as work progresses.

---

<details class="phase-complete">
<summary>Phase 0 — Public kickoff</summary>

- [x] GitHub org and monorepo created
- [x] Root README with doctrine
- [x] ROADMAP published
- [x] Initial site live
- [x] Issue templates and Discussions enabled

</details>

---

<details class="phase-complete">
<summary>Phase 1 — Freeze the model</summary>

- [x] Canonical `Invoice`, `Payment`, `EventEnvelope`, `WebhookEndpoint` shapes defined
- [x] Event vocabulary frozen: `invoice.created`, `payment.confirmed`, `invoice.completed`, `invoice.expired`, `invoice.canceled`
- [x] RFC 0001 — Project framing
- [x] RFC 0002 — Observe mode architecture
- [x] RFC 0003 — Event model and delivery semantics

</details>

---

<details class="phase-complete">
<summary>Phase 2 — Observe-mode MVP</summary>

- [x] `@openrai/watcher` — chain observation (WebSocket + RPC polling fallback)
- [x] `@openrai/runtime` — invoice lifecycle, payment matching, expiry, idempotency
- [x] `@openrai/webhook` — HMAC-SHA256 signing, verification, at-least-once delivery
- [x] Framework-agnostic REST API (web standard Request/Response)
- [x] Standalone server entry point
- [x] Store interfaces and in-memory implementations
- [x] Watcher/runtime decoupled via contract types in model
- [x] Test suite (103 tests across runtime, stores, HTTP handler, signing)

</details>

---

## Phase 3 — SDK and demos

- [x] Webhook signature verification helper (shipped in `@openrai/webhook`)
- [ ] `@openrai/sdk-js` typed client
- [ ] Reference Express integration
- [ ] Reference Next.js checkout demo
- [ ] Example webhook consumer

---

## Phase 4 — Hardening and pilot integrations

- [ ] Persistent store adapters (SQLite, Postgres)
- [ ] Observability and structured logs
- [ ] Integration tests against Nano test network
- [ ] Deployment documentation (Docker, standalone)
- [ ] At least one pilot integration

---

## Phase 5 — Optional custodial mode

- [ ] Treasury wallet operation
- [ ] Payouts and refunds
- [ ] Automated receive flows
- [ ] Explicit hot-wallet mode

Custody is not the default identity of RaiFlow. It is an optional higher-trust mode, added only when clearly justified.

---

## Phase 6 — Ecosystem layer

- [ ] Stable event and proof conventions
- [ ] Broader SDK support (Python, Go, etc.)
- [ ] Integration guides for wallets and services
- [ ] Public examples: usage-based billing, agent payments, API monetization
