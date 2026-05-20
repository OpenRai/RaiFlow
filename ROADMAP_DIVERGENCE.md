# Roadmap Divergence Report

**Audit date:** 2026-05-19 (updated from 2026-05-18 baseline)  
**Scope:** `rfcs/*.md` compared with the current implementation in `packages/`, `apps/site/`, `examples/`, root docs, and config files.  
**Status key:** `Aligned`, `Partial`, `Divergent`, `Not implemented`, `RFC conflict`, `Resolved`.

This report is intentionally detailed. It records where the RFC contract, roadmap, README/status docs, and runtime implementation no longer say the same thing.

## Executive Summary

The 2026-05-18 shipping round resolved several high-priority divergences:

- **Startup API-key enforcement** — `resolveApiKey()` is now called in `main.ts` and hard-fails if missing. (D-002 ✅)
- **Custodial seed validation** — Auto-generation removed; custodial mode now hard-fails when `custody.seed` or `custody.representative` is missing. (D-003 ✅)
- **Derivation namespace separation** — Invoice derivation starts at index 0, managed at 1,000,000. Runtime asserts they don't overlap. (D-005 ✅ at runtime level)
- **Invoice v2 event migration** — Runtime now emits `invoice.payment_received` and `invoice.payment_confirmed` instead of legacy `payment.confirmed`. All invoice events flow through `emitV2Event()`.
- **Global event polling** — `GET /api/events` is implemented with cursor-based pagination, backed by the persisted v2 event store.
- **Scoped idempotency** — Invoice create/cancel, managed account create, send queue, webhook create/delete, and block publish all use the shared `IdempotencyReplayStore`.
- **Invoice pay-address derivation** — `recipientAccount` is rejected; RaiFlow now derives `payAddress` per invoice via custody.

Remaining largest divergences:

- The implemented HTTP API is under `/api`, while RFC 0002 and RFC 0003 describe `/v1`.
- Webhook delivery semantics still diverge from RFC 0003 (signature format, 4xx retry, no persisted attempts).
- `nano-core` boundary is still not clean in custody.
- Legacy adapter layer (`LegacyInvoice`, `LegacyInvoiceStore`) remains as an internal shim between the v2 API surface and SQLite.
- Invoice derivation index calculation is fragile (counts all invoices rather than tracking a persistent high-water mark).
- Pre-signed block publish exists but emits no `block.*` events and has no confirmation tracking.

## Cross-Cutting Divergences

### D-001 — API Prefix and Route Contract Drift

**Status:** Divergent (unchanged)  
**RFCs:** RFC 0002 `Runtime HTTP API`, RFC 0003 `Event Polling`  
**Implementation:** [packages/runtime/src/handler.ts](packages/runtime/src/handler.ts)

RFC 0002 defines routes under `/v1`. The implementation exposes `/api/*` instead. SDK defaults also target `/api`, so the current public client and runtime agree with each other but not with RFC 0002/0003.

**Roadmap impact:** decide whether `/api` is the canonical route prefix and update RFCs/site docs, or add `/v1` compatibility routes.

### D-002 — Required API Key Is Not Enforced at Startup

**Status:** ✅ Resolved  
**Resolved in:** `625fec3`

`main.ts` now calls `resolveApiKey(config)` at startup, assigns the result into `config.daemon.apiKey`, and exits with a clear error if no key is found. `checkAuth()` in `handler.ts` uses the resolved key for Bearer token validation.

### D-003 — Custodial Seed Validation Was Replaced by Auto-Generation

**Status:** ✅ Resolved  
**Resolved in:** `625fec3`

The auto-generation block (`custody-seed.txt`, default representative) has been removed. Custodial mode now hard-fails at startup when `config.custody?.seed` or `config.custody?.representative` is missing.

### D-004 — Custody Mode Semantics Conflict Across RFCs

**Status:** RFC conflict, implementation follows RFC 0004 (unchanged)  
**RFCs:** RFC 0001 `Custody Modes`, RFC 0002 `Integration Modes`, RFC 0004 `Startup Mode`

RFC 0001/0002 say managed, watched, and pre-signed modes coexist in the same instance. RFC 0004 later says a single startup mode (`custodial` or `non-custodial`) gates capabilities. The implementation follows RFC 0004.

**Roadmap impact:** update RFC 0001/0002 or add an explicit supersession note pointing to RFC 0004.

### D-005 — Derivation Namespace Separation Is Not Enforced

**Status:** ✅ Resolved at runtime level, not enforced in custody engine  
**Resolved in:** `625fec3`

`main.ts` now defines `DERIVATION_START_INDEX = { invoice: 0, managed: 1_000_000 }` and asserts they are not equal. The `Runtime` constructor also validates `invoiceDerivationStartIndex !== managedDerivationStartIndex`. The custody engine itself still does not enforce range bounds internally — it trusts the caller to pass correct indices.

**Residual gap:** The RFC reserves `0x00000000–0x7FFFFFFF` for invoices and `0x80000000–0xFFFFFFFF` for managed. Current values (0 and 1,000,000) are within the RFC's invoice range. This is fine as long as managed index growth stays well below the invoice range ceiling, but the custody engine should eventually enforce hard upper bounds.

### D-006 — `nano-core` Boundary Is Not Clean in Custody

**Status:** Partial / Divergent (unchanged)  
**RFCs:** RFC 0001 `Motivation`, RFC 0002 `Custody Engine and nano-core`  
**Implementation:** [packages/custody/src/index.ts](packages/custody/src/index.ts)

The custody package imports `WorkProvider` from `@openrai/nano-core`, but it also directly imports `createBlock`, `deriveAddress`, `derivePublicKey`, `deriveSecretKey`, `signBlock`, and `computeWork` from `nanocurrency`.

**Roadmap impact:** decide whether this direct dependency is acceptable, or migrate custody protocol primitives behind `nano-core`.

### D-007 — Invoice Derivation Index Calculation Is Fragile (NEW)

**Status:** Divergent  
**Implementation:** [packages/runtime/src/runtime.ts](packages/runtime/src/runtime.ts) line 979-982

`getNextInvoiceDerivationIndex()` calculates the next index as `invoiceDerivationStartIndex + invoices.length` (counting all invoices, regardless of status). This has two problems:

1. **Deleted invoices would cause index reuse.** If invoice deletion is ever implemented, the count would decrease, causing a previously-used derivation index to be reused — potentially creating address collisions or privacy leaks.
2. **Performance.** Listing all invoices to count them scales poorly. A persisted high-water mark column or counter would be O(1) instead of O(n).

The managed account derivation index uses a max-scan approach, which is safer (monotonically increasing) but also O(n).

**Roadmap impact:** add a persisted `next_derivation_index` or high-water-mark column per namespace to make index assignment O(1) and deletion-safe.

### D-008 — Legacy Adapter Layer Still Intermediates Invoice Storage (NEW)

**Status:** Partial  
**Implementation:** [packages/runtime/src/main.ts](packages/runtime/src/main.ts) lines 170-176, [packages/runtime/src/runtime.ts](packages/runtime/src/runtime.ts)

The runtime now exposes a v2 API surface (v2 `Invoice` and `Payment` shapes, v2 events), but internally the `Runtime` class still operates on `LegacyInvoice` and `LegacyPayment` types, converting at the boundary via `legacyToV2Invoice()` and `legacyToV2Payment()`. The main process still wires through `createLegacySqliteInvoiceStore()` and `createLegacySqlitePaymentStore()` adapters.

This works correctly but means:

- Every invoice operation round-trips through a type conversion layer.
- The `LegacyInvoice` type uses `recipientAccount` internally while the v2 `Invoice` type uses `payAddress` — the adapter maps between them, but the internal naming mismatch creates maintenance risk.
- The `LegacyInvoiceStore` interface method `getByRecipientAccount()` is still the mechanism used for payment matching, even though invoices are now addressed by derived `payAddress`.

**Roadmap impact:** Refactor `Runtime` to operate directly on v2 `Invoice` / `Payment` types and the v2 `InvoiceStore` / `PaymentStore` interfaces from `@openrai/model`. Remove legacy adapters and the `Legacy*` types from `@openrai/model`.

## RFC 0001 — Project Framing

### Summary / Motivation / What RaiFlow Is

**Status:** Mostly aligned (improved)

The product framing is right. Invoice internals now expose v2 shapes at the API boundary and emit canonical v2 events, though legacy adapters remain internally.

### What RaiFlow Is Not / Out of Scope

**Status:** Mostly aligned (unchanged)

### Operational Domains

**Status:** Mostly aligned (improved from Partial)

The dual-domain runtime exists. Key improvements:

- Invoice pay-address derivation per invoice is now implemented — `POST /api/invoices` derives a `payAddress` via custody. The `recipientAccount` parameter is rejected.
- Deterministic invoice address mapping is meaningful: the same seed + index always produces the same address.

Remaining gaps:

- Auto-receive and treasury sweep are not implemented for invoices.

### Custody Modes

**Status:** Partial, superseded by RFC 0004 for startup behavior (unchanged)

### Core Primitives

**Status:** Partial (improved)

Improvements:

- Runtime invoice responses now return v2 `Invoice` shapes (with `payAddress`, `receivedAmountRaw`, etc.).
- Runtime payment queries return v2 `Payment` shapes.
- The global event query API (`GET /api/events`) is now exposed with cursor pagination.

Remaining gaps:

- No first-class runtime block resource is persisted; `/api/blocks` publishes directly through RPC.
- Legacy types remain as internal shims (D-008).

### Event Vocabulary

**Status:** Mostly aligned (improved from Partial / Divergent)

The runtime now emits canonical v2 events:

- Emits: `invoice.created`, `invoice.payment_received`, `invoice.payment_confirmed`, `invoice.completed`, `invoice.expired`, `invoice.canceled`, `account.created`, `account.balance_updated`, `send.queued`, `send.published`, `send.confirmed`, `send.failed`.
- Does not yet emit: `invoice.swept`, `account.received`, `account.removed`, `block.*`, `rpc.*`.

The legacy `payment.confirmed` event is no longer emitted by `handleConfirmedBlock()`. All invoice payment events now use the canonical `invoice.payment_received` and `invoice.payment_confirmed` names.

`AccountStateSync` still emits non-persisted SSE events (`account.state_synced`, `account.payment_received`, etc.) which are useful operationally but are not in the persisted event vocabulary.

### Idempotency

**Status:** Mostly aligned (improved from Partial)

Improvements:

- All key mutating operations now use scoped idempotency via `IdempotencyReplayStore`:
  - Invoice create (`invoice.create` scope)
  - Invoice cancel (`invoice.cancel` scope)
  - Managed account create (`account.create.managed` scope)
  - Send queue (`send.queue` scope)
  - Webhook create (`webhook.create` scope)
  - Webhook delete (`webhook.delete` scope)
  - Block publish (`block.publish` scope)
- Idempotency keys are accepted via `Idempotency-Key` HTTP header for invoice operations, webhook operations, and block publishing.

Remaining gaps:

- Work generation (`POST /api/work`) does not accept an idempotency key (arguably not needed since work generation is naturally idempotent for the same hash).
- Account PATCH does not accept an idempotency key.
- Watched account creation uses address-based deduplication (returns existing if same address) rather than key-based idempotency.

### Doctrine Summary

**Status:** Directionally aligned (improved)

The unified event stream is now significantly closer to the doctrine. Events are persisted via `emitV2Event()` and exposed through `GET /api/events`. The remaining gap is that not all state changes are represented (account PATCH, block publish, RPC state) in the canonical stream.

## RFC 0002 — Runtime Architecture

### System Diagram

**Status:** Mostly aligned (improved)

The runtime wires config, storage, RPC, custody, events, watcher, account state sync, webhook delivery, and SDK-facing HTTP routes. Event delivery now flows exclusively through v2 events for invoice lifecycle and wallet operations.

### Package Responsibilities

**`@openrai/model` — Status: Mostly aligned**

Canonical public types and store interfaces exist. Legacy types remain for backward compatibility but are clearly marked for removal. New v2 types (`Invoice`, `Payment`, `EventQueryOptions`, `PaginatedEventsResponse`, `IdempotencyRecord`, `IdempotencyReplayStore`) are implemented and used.

**`@openrai/config` — Status: Mostly aligned**

Startup enforcement is now the runtime's responsibility and is implemented for API key and custodial seed validation.

**`@openrai/storage` — Status: Mostly aligned (improved)**

SQLite schema, migration runner, and store adapters exist. The `createSqliteIdempotencyReplayStore()` is now implemented and used for scoped idempotency across all mutating operations.

Remaining gap: delivery attempts table exists but is not used by webhook delivery.

**`@openrai/rpc` — Status: Partial (unchanged)**

Runtime-level infrastructure event persistence for `rpc.connected`, `rpc.disconnected`, and `rpc.failover` is not wired.

**`@openrai/events` — Status: Mostly aligned (improved from Partial)**

Persist-first append and an in-process bus exist. The runtime now exposes a global event query route (`GET /api/events`) with cursor-based pagination.

**`@openrai/custody` — Status: Partial / Divergent**

Improvements: derivation namespace separation is enforced at the runtime level (D-005).

Remaining divergent pieces:

- clean `nano-core` boundary (D-006)
- representative management beyond a placeholder
- auto-receive pipeline
- durable frontier store integration

**`@openrai/runtime` — Status: Partial (improved)**

Improvements: startup validation, idempotency for all mutating operations, global event API, invoice v2 surface, invoice pay-address derivation.

Remaining: request IDs, structured error middleware, account deletion, complete removal of legacy adapter layer.

**`@openrai/webhook` — Status: Partial / Divergent (unchanged)**

Divergences from RFC 0003:

- signature format is `t=<timestamp>,v1=<hex>`, not `sha256=<hex_digest>`
- signed payload is `timestamp.body`, not only raw JSON body
- 4xx responses are retried, while RFC 0003 says 4xx should not retry
- jitter range is 50%-100% of computed delay, not +/-25%
- persisted delivery logging is not wired

**`@openrai/raiflow-sdk` — Status: Mostly aligned with current implementation**

`recipientAccount` is now deprecated on `InvoicesResource.create()`. The SDK matches the current `/api` surface.

### Runtime HTTP API

**Status:** Partial (improved from Divergent)

Improvements:

- `GET /api/events` is now implemented with query parameters: `after`, `type`, `resourceType`, `resourceId`, `limit`.
- `POST /api/invoices` no longer accepts `recipientAccount` (returns 400 with deprecation message).
- `POST /api/invoices/:id/cancel` accepts `Idempotency-Key` header.
- `POST /api/webhooks`, `DELETE /api/webhooks/:id`, `POST /api/blocks` accept `Idempotency-Key` header.

Remaining route gaps vs RFC 0002:

| RFC route | Current implementation |
|---|---|
| `/v1/*` prefix | `/api/*` (D-001) |
| `DELETE /v1/accounts/:id` | Missing |

Additional implemented routes not in RFC 0002 include `/`, `/dashboard`, `/api/version`, `/api/accounts/:id/receivable`, `/api/accounts/stream`, `/api/sends/:id`, `/api/invoices/:id/events`, and `GET /api/events`.

### Custody Engine and nano-core

**Status:** Partial (improved)

Derivation namespace separation is enforced (D-005). Invoice address derivation is implemented. Remaining: clean `nano-core` boundary (D-006), receive/change orchestration.

### Integration Modes

**Status:** RFC conflict, implementation follows RFC 0004 (unchanged)

### Sweep Mechanics

**Status:** Not implemented (unchanged)

`autoSweep` and `sweepDestination` exist in config, but no invoice completion sweep path is wired. No `invoice.swept` event is emitted.

## RFC 0003 — Event Model

### Summary and Design Principles

**Status:** Mostly aligned (improved from Partial)

Persist-first behavior is true for all `emitV2Event()` calls before webhook delivery. All invoice lifecycle events and wallet domain events go through the v2 path.

Remaining gaps:

- Account PATCH, block publish, RPC state changes are not in the persisted event stream.
- Account SSE events are not persisted event envelopes.

### Event Envelope

**Status:** Aligned for v2 events (improved)

The v2 `RaiFlowEvent` envelope matches the RFC. Legacy event envelopes are no longer emitted by the invoice lifecycle — all events use `emitV2Event()`.

### Event Taxonomy

**Status:** Mostly aligned (improved from Partial / Divergent)

The runtime now emits canonical `invoice.payment_received` and `invoice.payment_confirmed`. The legacy `payment.confirmed` is no longer emitted by `handleConfirmedBlock()`.

### Resource Shapes

**Status:** Mostly aligned (improved from Mixed)

- Accounts and sends use canonical shapes.
- Invoices are now exposed through v2 `Invoice` shape at the API boundary (with `payAddress`, `receivedAmountRaw`).
- Payments are now exposed through v2 `Payment` shape at the API boundary (with `blockHash`, `senderAddress`).
- `WebhookEndpoint` shape is aligned.
- Block state is not persisted as a first-class resource.

### Delivery Semantics

**Status:** Partial / Divergent (unchanged)

See webhook package notes above.

### Event Polling

**Status:** ✅ Resolved  
**Resolved in:** `625fec3`

`GET /api/events` is now implemented with query parameters: `after` (cursor), `type`, `resourceType`, `resourceId`, `limit`. Responses include `data` and `nextCursor` for pagination. The implementation uses the v2 `EventStore.list()` method backed by SQLite.

### Idempotency Invariants

**Status:** Mostly aligned (improved from Partial)

Improvements:

- The invariant text now matches the taxonomy: `invoice.payment_confirmed` events are emitted, not `payment.confirmed`.
- All mutating APIs accept idempotency keys via the shared `IdempotencyReplayStore`.
- Managed account creation properly stores and replays idempotency keys.

### Intentionally Not Canonized Yet

**Status:** Aligned (improved from Partly contradicted)

The implementation no longer canonizes legacy `payment.confirmed` events. The RFC's intentionally-excluded events (`payment.detected`, `invoice.partially_paid`, `webhook.delivery_failed`) are correctly absent.

## RFC 0004 — Custodial Modes and SDK Philosophy

### Startup Mode

**Status:** Aligned (unchanged)

### Mode-Gated Features

**Status:** Mostly aligned (unchanged)

### Custodial Mode Validation

**Status:** ✅ Resolved (was Divergent)

Missing custody config now hard-fails startup in custodial mode.

### API Key

**Status:** ✅ Resolved (was Divergent)

`resolveApiKey()` is called at startup and exits if no key is found.

### SDK Philosophy

**Status:** Mostly aligned (unchanged)

### Consequences

**Status:** Aligned (improved from Partial)

README, Docker Compose, config examples, and runtime implementation all enforce `RAIFLOW_MODE` and `RAIFLOW_API_KEY`.

## Link Check Findings

**Status:** ✅ Resolved

`CONTRIBUTING.md` no longer links to the non-existent `./CODE_OF_CONDUCT.md`.

## Recommended Next Roadmap Items

### High Priority

1. **Persist invoice derivation index** (D-007) — Replace `invoices.length` counting with a persistent high-water mark. This is a correctness risk if invoice deletion is ever added.
2. **Remove legacy adapter layer** (D-008) — Refactor `Runtime` to operate directly on v2 `InvoiceStore`/`PaymentStore` interfaces. Remove `LegacyInvoice`, `LegacyPayment`, `LegacyEventStore`, and the `sqlite-legacy-adapters.ts` shim.
3. **Wire persisted webhook delivery attempts** — The `webhook_deliveries` table exists but the delivery engine does not write attempt records. This blocks replay and observability.
4. **Fix webhook 4xx retry policy** — RFC 0003 says 4xx should not retry. Current implementation retries all non-2xx.

### Medium Priority

5. Pick the canonical route prefix (`/api` vs `/v1`) and update either runtime aliases or RFC/docs (D-001).
6. Add block publish events and confirmation tracking for pre-signed flows (`block.published`, `block.confirmed`, `block.failed`).
7. Add runtime infrastructure events from RPC pool state changes (`rpc.connected`, `rpc.disconnected`, `rpc.failover`).
8. Update site docs to include RFC 0004 and current route names after the contract decision is made.

### Lower Priority

9. Enforce hard derivation index bounds in the custody engine itself (D-005 residual).
10. Migrate custody protocol primitives behind `nano-core` (D-006).
11. Update RFC 0001/0002 with supersession notes pointing to RFC 0004 (D-004).
12. Add `account.removed` event and `DELETE /api/accounts/:id` endpoint.
13. Wire `account.received` as a persisted event distinct from `account.balance_updated`.
14. Implement auto-receive for managed accounts.
15. Implement invoice completion sweep (`autoSweep` + `invoice.swept` event).
