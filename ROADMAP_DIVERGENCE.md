# Roadmap Divergence Report

**Audit date:** 2026-05-18  
**Scope:** `rfcs/*.md` compared with the current implementation in `packages/`, `apps/site/`, `examples/`, root docs, and config files.  
**Status key:** `Aligned`, `Partial`, `Divergent`, `Not implemented`, `RFC conflict`.

This report is intentionally detailed. It records where the RFC contract, roadmap, README/status docs, and runtime implementation no longer say the same thing.

## Executive Summary

The repository has advanced beyond the old roadmap in the wallet/API/SDK areas, but several accepted RFC guarantees are still not true in the runtime. The largest divergences are:

- The implemented HTTP API is under `/api`, while RFC 0002 and RFC 0003 describe `/v1`.
- Invoice storage uses v2 tables, but invoice runtime behavior still goes through legacy adapters and exposes prototype-era shapes/events in places.
- The global event log exists in storage, but no global event polling route is exposed.
- Webhook delivery is signed and retried, but delivery attempts are not persisted by the delivery engine and retry semantics differ from RFC 0003.
- Startup mode gating exists, but required API-key and custodial seed validation are not fully enforced.
- Derivation namespace separation is an accepted invariant, but runtime custody wiring starts invoice and managed derivation at the same index.
- Pre-signed block publish exists as an RPC pass-through, but block events and confirmation tracking are not implemented.
- RFC 0001/0002 describe custody modes coexisting in one instance, while RFC 0004 and implementation use startup mode gating. RFC 0004 is the newer accepted decision.

## Cross-Cutting Divergences

### D-001 — API Prefix and Route Contract Drift

**Status:** Divergent  
**RFCs:** RFC 0002 `Runtime HTTP API`, RFC 0003 `Event Polling`  
**Implementation:** [packages/runtime/src/handler.ts](packages/runtime/src/handler.ts)

RFC 0002 defines routes under `/v1`, including `GET /v1/events`, `POST /v1/work/generate`, `POST /v1/publish`, and `POST /v1/accounts/:id/send`. The implementation exposes `/api/*` instead, with routes such as `/api/accounts/:id/sends`, `/api/blocks`, `/api/work`, and no global `/api/events` equivalent.

This is not just naming drift. SDK defaults also target `/api`, so the current public client and runtime agree with each other but not with RFC 0002/0003.

**Roadmap impact:** decide whether `/api` is the canonical route prefix and update RFCs/site docs, or add `/v1` compatibility routes.

### D-002 — Required API Key Is Not Enforced at Startup

**Status:** Divergent  
**RFCs:** RFC 0004 `API Key`  
**Implementation:** [packages/runtime/src/main.ts](packages/runtime/src/main.ts), [packages/runtime/src/handler.ts](packages/runtime/src/handler.ts), [packages/runtime/src/auth.ts](packages/runtime/src/auth.ts)

RFC 0004 requires `RAIFLOW_API_KEY` or `daemon.apiKey` and says startup should fail if neither exists. The implementation has `resolveApiKey()`, but `main.ts` imports it without calling it. `checkAuth()` returns `undefined` when `config.daemon.apiKey` is absent, which leaves routes unauthenticated.

**Roadmap impact:** M1/M7 should track startup API-key enforcement separately from Bearer auth middleware.

### D-003 — Custodial Seed Validation Was Replaced by Auto-Generation

**Status:** Divergent  
**RFCs:** RFC 0004 `Custodial Mode Validation`  
**Implementation:** [packages/runtime/src/main.ts](packages/runtime/src/main.ts)

RFC 0004 says custodial mode must fail startup when `custody.seed` or `custody.representative` is missing. The current main process generates `custody-seed.txt` beside the SQLite database and uses a default representative when `mode === 'custodial' && !config.custody`.

This is a material security/product decision divergence: auto-generated custody is convenient for local development, but the RFC explicitly rejected hidden material.

**Roadmap impact:** M7 should decide whether to remove auto-generation, gate it behind a dev flag, or amend RFC 0004.

### D-004 — Custody Mode Semantics Conflict Across RFCs

**Status:** RFC conflict, implementation follows RFC 0004  
**RFCs:** RFC 0001 `Custody Modes`, RFC 0002 `Integration Modes`, RFC 0004 `Startup Mode`

RFC 0001/0002 say managed, watched, and pre-signed modes coexist in the same instance. RFC 0004 later says a single startup mode (`custodial` or `non-custodial`) gates capabilities. The implementation follows RFC 0004: watched accounts, blocks, and work are available in non-custodial mode; managed accounts, sends, and invoices are rejected with 501.

**Roadmap impact:** update RFC 0001/0002 or add an explicit supersession note pointing to RFC 0004.

### D-005 — Derivation Namespace Separation Is Not Enforced

**Status:** Divergent  
**RFCs:** RFC 0001 `Operational Domains`, RFC 0002 `@openrai/custody`  
**Implementation:** [packages/runtime/src/main.ts](packages/runtime/src/main.ts), [packages/custody/src/index.ts](packages/custody/src/index.ts)

RFC 0002 reserves invoice indexes `0x00000000-0x7FFFFFFF` and managed account indexes `0x80000000-0xFFFFFFFF`. Current runtime custody creation passes `derivationStartIndex: { invoice: 0, managed: 0 }`. The custody engine exposes separate methods but does not enforce ranges.

**Roadmap impact:** M2 should track namespace enforcement before invoice pay-address derivation lands.

### D-006 — `nano-core` Boundary Is Not Clean in Custody

**Status:** Partial / Divergent  
**RFCs:** RFC 0001 `Motivation`, RFC 0002 `Custody Engine and nano-core`  
**Implementation:** [packages/custody/src/index.ts](packages/custody/src/index.ts)

The RFCs say `@openrai/nano-core` owns Nano protocol primitives such as address encoding, amount math, client calls, block construction helpers, and `WorkProvider`. The custody package imports `WorkProvider` from `@openrai/nano-core`, but it also directly imports `createBlock`, `deriveAddress`, `derivePublicKey`, `deriveSecretKey`, `signBlock`, and `computeWork` from `nanocurrency`.

**Roadmap impact:** decide whether this direct dependency is acceptable, or migrate custody protocol primitives behind `nano-core`.

## RFC 0001 — Project Framing

### Summary / Motivation / What RaiFlow Is

**Status:** Mostly aligned

The package layout and runtime direction match the framing: RaiFlow sits between apps and Nano nodes, owns orchestration/storage/events, and does not try to become an e-commerce layer.

Notable gap: README/status docs now describe invoices as shipped, but the implementation still uses legacy invoice adapters. The product framing is right; the invoice internals have not fully caught up.

### What RaiFlow Is Not / Out of Scope

**Status:** Mostly aligned

No consumer wallet, SaaS gateway, cart/catalog system, fiat platform, Nano node, or block explorer is implemented. The SSR dashboard exists, but it is an operator dashboard rather than a consumer wallet UI.

### Operational Domains

**Status:** Partial

The dual-domain runtime exists. Wallet-domain accounts/sends and invoice-domain create/list/cancel/payment matching both run in one `Runtime`.

Gaps:

- Invoice pay-address derivation per invoice is not implemented; `POST /api/invoices` requires a caller-provided `recipientAccount`.
- Auto-receive and treasury sweep are not implemented for invoices.
- Deterministic invoice address mapping is not meaningful yet because invoice address selection is not owned by RaiFlow.

### Custody Modes

**Status:** Partial, superseded by RFC 0004 for startup behavior

Managed accounts, watched accounts, and pre-signed publishing all exist as concepts. The implementation does not allow every mode simultaneously in all startup modes: non-custodial mode rejects managed accounts, sends, and invoices.

### Core Primitives

**Status:** Partial

Implemented primitives:

- `Invoice`, `Payment`, `Account`, `Send`, `RaiFlowEvent`, and `WebhookEndpoint` exist in [packages/model/src/index.ts](packages/model/src/index.ts).
- SQLite stores exist for those resources.
- SDK resources exist for accounts, sends, invoices, webhooks, blocks, work, and system.

Gaps:

- Runtime invoice responses still return legacy invoice fields through adapters.
- No first-class runtime block resource is persisted; `/api/blocks` publishes directly through RPC.
- `Event` is persisted, but the global query API is missing.

### Event Vocabulary

**Status:** Partial / Divergent

The canonical event union includes the RFC vocabulary, but the runtime only emits part of it:

- Emits v2 wallet events: `account.created`, `account.balance_updated`, `send.queued`, `send.published`, `send.confirmed`, `send.failed`.
- Emits legacy invoice events: `invoice.created`, `payment.confirmed`, `invoice.completed`, `invoice.expired`, `invoice.canceled`.
- Does not emit canonical `invoice.payment_received`, `invoice.payment_confirmed`, `invoice.swept`, `account.received`, `account.removed`, `block.*`, or `rpc.*` events.

`AccountStateSync` emits non-persisted account SSE events such as `account.payment_received`, which are useful operationally but are not the RFC 0001/0003 persisted event vocabulary.

### Idempotency

**Status:** Partial

Strongly aligned for sends: missing `idempotencyKey` is rejected and duplicate send keys return the original send. Invoice creation supports the `Idempotency-Key` header.

Gaps:

- Not every mutating operation accepts an idempotency key. Account update, watched-account creation, invoice cancel, webhook create, webhook delete, block publish, and work generation do not have the same idempotency model.
- Managed account creation accepts an `idempotencyKey` in the request shape, but the runtime does not currently use it to deduplicate account creation.

### Doctrine Summary

**Status:** Directionally aligned

The repo matches the "thin runtime" doctrine. The largest doctrine-level gap is still the unified event stream: events are persisted, but not all state changes are represented in the canonical stream and no global polling route exists.

## RFC 0002 — Runtime Architecture

### System Diagram

**Status:** Mostly aligned

The runtime wires config, storage, RPC, custody, events, watcher, account state sync, webhook delivery, and SDK-facing HTTP routes. The main divergence is that event delivery is split between legacy invoice events, v2 wallet events, account SSE events, and webhook retries.

### Package Responsibilities

**`@openrai/model` — Status: Aligned with some legacy debt**

Canonical public types and store interfaces exist. Legacy aliases remain so the runtime can keep building while invoice behavior is rewritten.

**`@openrai/config` — Status: Mostly aligned**

YAML parsing, `env:` resolution, typed config, and mode parsing exist. The config package parses optional API key and custody config; startup enforcement is the runtime's responsibility and currently incomplete.

**`@openrai/storage` — Status: Mostly aligned**

SQLite schema, migration runner, and store adapters exist. Transaction helpers are not obvious in the current public API. Delivery attempts have a table but are not used by webhook delivery.

**`@openrai/rpc` — Status: Partial**

Multi-endpoint HTTP RPC, active difficulty, failover/audit integration, WebSocket client primitives, and state listeners exist. Runtime-level infrastructure event persistence for `rpc.connected`, `rpc.disconnected`, and `rpc.failover` is not wired.

**`@openrai/events` — Status: Partial**

Persist-first append and an in-process bus exist. Cursor-like listing exists at the storage interface, but global event query routes and filter helpers are not exposed in the runtime.

**`@openrai/custody` — Status: Partial / Divergent**

Seed loading, derivation, signing, and work generation exist. Missing or divergent pieces:

- namespace range enforcement
- clean `nano-core` boundary
- representative management beyond a placeholder
- auto-receive pipeline
- durable frontier store integration

**`@openrai/runtime` — Status: Partial**

Runtime orchestration, API key middleware when configured, invoice/account/send/webhook services, dashboard, watcher, and startup wiring exist. Request IDs, structured error middleware, global event API, account deletion, and complete invoice v2 service remain incomplete.

**`@openrai/webhook` — Status: Partial / Divergent**

HMAC signing, verification helper, delivery, and in-memory retry scheduling exist. Divergences from RFC 0003:

- signature format is `t=<timestamp>,v1=<hex>`, not `sha256=<hex_digest>`
- signed payload is `timestamp.body`, not only raw JSON body
- 4xx responses are retried, while RFC 0003 says 4xx should not retry
- jitter range is 50%-100% of computed delay, not +/-25%
- persisted delivery logging is not wired

**`@openrai/raiflow-sdk` — Status: Mostly aligned with current implementation**

REST resource classes exist for the current `/api` surface. The SDK does not implement WebSocket subscriptions; it implements account SSE watching. It re-exports model types from the package entry point.

### Runtime HTTP API

**Status:** Divergent

The implemented route surface differs from RFC 0002:

| RFC route | Current implementation |
|---|---|
| `GET /v1/events` | Missing |
| `POST /v1/work/generate` | `POST /api/work` |
| `POST /v1/publish` | `POST /api/blocks` |
| `POST /v1/accounts/:id/send` | `POST /api/accounts/:id/sends` |
| `POST /v1/watch`, `GET /v1/watch`, `DELETE /v1/watch/:account` | Watched accounts are created with `POST /api/accounts { type: "watched" }`; streaming uses `/api/accounts/stream` plus `/api/accounts/:id/watch` |
| `DELETE /v1/accounts/:id` | Missing |

Additional implemented routes not in RFC 0002 include `/`, `/dashboard`, `/api/version`, `/api/accounts/:id/receivable`, `/api/accounts/stream`, `/api/sends/:id`, and `/api/invoices/:id/events`.

### Custody Engine and nano-core

**Status:** Partial / Divergent

See D-005 and D-006. The runtime uses custody for send signing and work generation, but invoice derivation, receive/change orchestration, namespace enforcement, and a clean `nano-core` boundary are incomplete.

### Integration Modes

**Status:** RFC conflict, implementation follows RFC 0004

The examples in RFC 0002 assume modes coexist as capabilities. Current implementation uses startup mode. Non-custodial mode accepts watched accounts, block publish, and work; it rejects invoices, managed accounts, and sends.

### Sweep Mechanics

**Status:** Not implemented

`autoSweep` and `sweepDestination` exist in config, but no invoice completion sweep path is wired. No `invoice.swept` event is emitted.

## RFC 0003 — Event Model

### Summary and Design Principles

**Status:** Partial

Persist-first behavior is true for `emitEvent()` and `emitV2Event()` before webhook delivery. At-least-once webhook delivery is attempted via retries.

Gaps:

- Not every state change emits a canonical persisted event. Account PATCH, account removal, block publish, RPC state changes, and some account receive observations are missing from the persisted event stream.
- Events are ordered by UUID cursor in storage listing, not by a monotonic sequence. Global ordering is already best-effort by RFC, but UUID `id > after` cursor semantics can be surprising.
- Account SSE events are not persisted event envelopes.

### Event Envelope

**Status:** Mostly aligned for v2 events

The v2 `RaiFlowEvent` envelope matches the RFC and adds `resourceType: 'rpc'`. Legacy invoice events are adapted into the v2 event store, but when read through invoice-local APIs they are mapped back to `createdAt` and legacy type names.

### Event Taxonomy

**Status:** Partial / Divergent

See RFC 0001 event vocabulary notes. The most important mismatch is the invoice event naming: runtime emits `payment.confirmed`, while RFC 0003 defines `invoice.payment_received` and `invoice.payment_confirmed`.

### Resource Shapes

**Status:** Mixed

The canonical shapes exist in `@openrai/model` and SQLite storage. Runtime APIs are mixed:

- Accounts and sends use canonical shapes.
- Invoices and payments are still exposed through legacy shapes in runtime code paths.
- `WebhookEndpoint` shape is aligned.
- Block state is not persisted as a first-class resource.

### Delivery Semantics

**Status:** Partial / Divergent

Webhook delivery attempts are retried, but the RFC delivery policy is not exactly implemented:

- first attempts are awaited, retries are in-memory timers
- no persisted attempt log is written by the delivery engine
- retry behavior retries 4xx responses
- max retry count exists but the attempt numbering does not map directly to a persisted `attempt` row
- signature format differs from the RFC

### Event Polling

**Status:** Not implemented at runtime

The event store can list events with `after`, `type`, `resourceType`, `resourceId`, and `limit`, but the runtime does not expose `GET /v1/events` or `GET /api/events`.

### Idempotency Invariants

**Status:** Partial

Aligned:

- Payment confirmation has a block-hash guard and the SQLite payment table has a unique `block_hash`.
- Send idempotency works by idempotency key.
- Invoice creation idempotency works when a key is provided.
- Completion is terminal in the cancel path and expiry path.
- Confirmed invoice amount is monotonic in the current matching flow.

Gaps:

- The invariant text still names duplicate `payment.confirmed` events, while the taxonomy moved to `invoice.payment_confirmed`.
- Account balance can decrease through sends, which is allowed by the RFC only when there is a corresponding send record. The send path creates that record, but not all balance changes emit a persisted balance event.
- Not all mutating APIs accept idempotency keys.

### Intentionally Not Canonized Yet

**Status:** Partly contradicted by implementation

The RFC says `payment.detected` / `payment.observed`, `invoice.partially_paid`, and `webhook.delivery_failed` are intentionally not canonized. The implementation does not canonize those. However, the implementation does still canonize legacy `payment.confirmed`, which is outside the RFC 0003 event taxonomy.

## RFC 0004 — Custodial Modes and SDK Philosophy

### Startup Mode

**Status:** Aligned

`RAIFLOW_MODE` / `daemon.mode` is parsed and `main.ts` refuses to start if no mode is set.

### Mode-Gated Features

**Status:** Mostly aligned

Implemented gates:

- Managed account creation returns 501 in non-custodial mode.
- Sends return 501 in non-custodial mode.
- Invoices return 501 in non-custodial mode.
- Watched accounts, block publishing, work generation, and GET endpoints remain available.

Potential gap: the runtime returns `not_implemented` for route-level feature gates, but lower-level runtime methods throw `bad_request` if called directly.

### Custodial Mode Validation

**Status:** Divergent

See D-003. Missing custody config does not fail startup; it triggers seed auto-generation.

### API Key

**Status:** Divergent

See D-002. The resolver exists and tests cover it, but the main startup path does not enforce it.

### SDK Philosophy

**Status:** Mostly aligned

The SDK requires `apiKey` in `RaiFlowClientOptions`, exposes `SendsResource` as the normal fund movement API, and documents `BlocksResource` and `WorkResource` as low-level/non-custodial escape hatches.

### Consequences

**Status:** Partial

README, Docker Compose, and config examples document required `RAIFLOW_MODE` and `RAIFLOW_API_KEY`. The runtime implementation has not fully caught up with the stated API-key and custody validation consequences.

## Link Check Findings

Automated relative Markdown link checking found one broken internal target:

- `CONTRIBUTING.md` linked to `./CODE_OF_CONDUCT.md`, which does not exist.

That link has been removed rather than replaced with a new policy document.

## Recommended Next Roadmap Items

1. Pick the canonical route prefix (`/api` vs `/v1`) and update either runtime aliases or RFC/docs.
2. Enforce API-key and custody startup guarantees or amend RFC 0004 with a dev-mode exception.
3. Fix derivation namespace separation before native invoice address derivation lands.
4. Finish invoice v2 API/event migration and remove legacy adapters from the runtime boundary.
5. Add global event polling over the existing event store.
6. Wire persisted webhook delivery attempts into the delivery engine.
7. Add block publish events and confirmation tracking for pre-signed flows.
8. Add runtime infrastructure events from RPC pool state changes.
9. Update site docs to include RFC 0004 and current route names after the contract decision is made.
