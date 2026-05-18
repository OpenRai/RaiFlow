# Roadmap

This file tracks where RaiFlow is headed and what is actually in flight.

It is not a launch checklist and it is not product copy. The point is to show
what exists, what is partially connected, and what still needs to be built.

**Status reviewed:** 2026-05-18.

## Current State

Implemented in the repository today:

- `packages/config` loads YAML, resolves `env:` references, and validates typed runtime config.
- `packages/storage` provides SQLite storage, forward-only migrations, and stores for invoices, payments, accounts, sends, events, webhooks, and webhook delivery rows.
- `packages/events` provides a persist-first event wrapper and in-process event bus.
- `packages/rpc` wraps `@openrai/nano-core` RPC/work providers with multi-endpoint failover, active-difficulty caching, and WebSocket client primitives.
- `packages/custody` provides seed loading, deterministic account derivation, block signing, and work generation primitives.
- `packages/runtime` boots from config, runs migrations, wires storage/RPC/custody/events, exposes a web-standard `Request`/`Response` handler, starts the watcher, and serves an SSR operator dashboard.
- Runtime HTTP routes exist under `/api` for health/version, accounts, account SSE streams, sends, invoices, invoice-local events, webhooks, pre-signed block publishing, and work generation.
- `@openrai/raiflow-sdk` covers the current runtime surface for accounts, sends, invoices, webhooks, blocks, work, system calls, and account SSE watching.
- Docker image, Docker Compose example, deployment quickstart, API-key Bearer auth when configured, and startup mode gating are present.

Still incomplete or divergent at the runtime/product level:

- Invoice runtime behavior still runs through legacy adapters. Storage uses the v2 tables, but the API and emitted invoice/payment events still expose prototype-era shapes in places.
- The runtime uses `/api` routes, while older architecture docs still describe `/v1` routes.
- There is no global event polling endpoint yet; only invoice-local legacy event queries and account SSE streams are exposed.
- Pre-signed block publishing is available, but block publish/confirm/fail events and confirmation tracking are not wired.
- Webhook delivery retries happen in memory, but persisted delivery attempt logging and restart recovery are not wired into the delivery engine.
- API-key and custodial seed startup guarantees are not fully aligned with the accepted RFCs.
- Derivation namespace separation is not enforced in the current custody wiring.
- Examples and site docs are usable orientation material, but some pages lag the current runtime surface.

See `ROADMAP_DIVERGENCE.md` for the detailed RFC-vs-implementation audit.

## Milestones

### M1 — Foundation

Mostly implemented:

- [x] Typed YAML config loader with `env:` resolution
- [x] SQLite storage with forward-only migration runner
- [x] Initial schema for invoices, payments, accounts, sends, events, webhooks, delivery attempts, and migrations
- [x] Persisted event log base implementation
- [x] In-process event bus
- [x] Daemon bootstrap from config and storage
- [x] API-key Bearer authentication when `daemon.apiKey` is configured
- [x] Startup mode enforcement (`custodial` / `non-custodial`)
- [ ] Require API key at startup in all non-test deployments
- [ ] Request correlation IDs and stronger readiness semantics
- [ ] Complete removal of prototype-era domain wiring from the runtime

### M2 — RPC and Custody Core

Core primitives implemented:

- [x] Multi-node RPC client foundation
- [x] WebSocket confirmation client foundation
- [x] Active difficulty lookup and work generation through the RPC pool
- [x] Seed loading and deterministic derivation primitives
- [x] Send block signing used by the runtime send pipeline
- [x] Runtime send pipeline fetches account frontier/balance before publishing
- [ ] Runtime-level infrastructure events like `rpc.connected`, `rpc.disconnected`, and `rpc.failover`
- [ ] Enforced invoice-vs-managed derivation namespace separation
- [ ] Receive and representative-change orchestration exposed through the runtime
- [ ] Full auto-receive pipeline for managed accounts

### M3 — Wallet Domain

Mostly implemented:

- [x] Create managed accounts from seed
- [x] Create and list watched accounts
- [x] List, get, and update accounts
- [x] Query receivable blocks for an account
- [x] Account state sync with initial reconciliation and periodic reconciliation
- [x] Account SSE stream with dynamic subscribe/unsubscribe
- [x] Idempotent sends from managed accounts
- [x] Send state machine: `queued -> published -> confirmed | failed`
- [x] Global send lookup and account-scoped send listing
- [x] Pre-signed block publishing API
- [x] Work generation API
- [ ] Delete/remove account semantics and persisted `account.removed`
- [ ] Persisted `account.received` events for inbound blocks
- [ ] Restart recovery for queued/published sends
- [ ] Pre-signed block confirmation tracking and `block.*` events

### M4 — Invoice Domain Rebuild

Current convergence focus:

- [ ] Pay-address derivation per invoice instead of caller-provided recipient accounts
- [ ] Invoice lifecycle fully rebuilt on native v2 resource shapes
- [ ] Payment detection and matching using the canonical `Payment` shape at the API boundary
- [ ] Canonical invoice payment events: `invoice.payment_received` and `invoice.payment_confirmed`
- [ ] Completion, expiry, and cancellation rules on the v2 path
- [ ] Partial and overpayment recording aligned with completion policy
- [ ] Treasury sweep through the wallet send pipeline
- [ ] `invoice.swept` event emission and sweep recovery

### M5 — Delivery Surfaces

Partially implemented:

- [x] Webhook endpoint CRUD
- [x] HMAC-signed webhook payload delivery
- [x] In-memory webhook retry scheduling
- [x] Account-specific SSE subscriptions
- [ ] Global event polling API over the v2 event store
- [ ] Persisted webhook delivery attempts used by the delivery engine
- [ ] Webhook retry recovery after restart
- [ ] Global event subscription stream
- [ ] Block and infrastructure event delivery through the same event surface

### M6 — SDK, Examples, and Site Docs

Partially implemented:

- [x] `@openrai/raiflow-sdk` aligned with the current `/api` runtime surface
- [x] SDK account SSE helper with reconnecting shared connection
- [x] SDK resources for accounts, sends, invoices, webhooks, blocks, work, and system
- [ ] SDK/event types reconciled after the invoice v2 rebuild
- [ ] Express example verified against the current v2 runtime
- [ ] Next.js checkout example verified against the current v2 runtime
- [ ] Webhook consumer example verified against the current webhook signature format
- [ ] HTMX wallet example verified against account SSE and send flows
- [ ] VitePress docs updated for RFC 0004 and current route names

### M7 — Hardening

In progress:

- [x] Docker image
- [x] Docker Compose example
- [x] Deployment documentation
- [x] Startup RPC probe with degraded-mode warnings and fatal all-endpoint failure
- [x] Non-custodial feature gates for managed accounts, sends, and invoices
- [ ] Restart recovery and in-flight operation resumption
- [ ] Integration tests against a Nano test environment
- [ ] Security review for seed handling, auth, webhook verification, and send safety
- [ ] Startup enforcement for required API key and custody config
- [ ] Clear production readiness/readiness probe semantics

## Replacement Note

This roadmap replaces the old prototype-phase roadmap.

The important distinction is:

- the prototype proved the shape of the system
- the current work is converging the implementation, API surface, and RFC contract into one consistent runtime

See `rfcs/0001-project-framing.md` for the framing behind that shift.
