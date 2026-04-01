# RaiFlow Progress & Plan

**Purpose:** Bootstrap document for new coding sessions. Contains stable architecture context, current phase status, and actionable next steps.
**Last updated:** 2026-03-31 (Phase 1 completed)
**Note:** This plan is not set in stone — it will evolve as the project progresses. Update this file as phases complete or priorities shift.

---

## Architecture at a Glance

### Package Map

```
┌──────────────────────────────────────────────────────────────────┐
│  @openrai/model (canonical types, interfaces, contracts)         │
│  Exports: Invoice, Payment, EventEnvelope, InvoiceStore,         │
│           PaymentStore, WatcherSink, ConfirmedBlock,             │
│           WebhookEndpoint, Logger                                │
└──────────┬──────────────┬──────────────┬──────────────┬──────────┘
           │              │              │              │
     ┌─────▼─────┐  ┌────▼─────┐  ┌─────▼─────┐  ┌────▼──────┐
     │  watcher   │  │ runtime  │  │  webhook   │  │raiflow-sdk│
     │ (observe)  │  │ (match)  │  │ (deliver)  │  │ (client)  │
     └────────────┘  └──────────┘  └────────────┘  └─────┬─────┘
                                                         │
                                              ┌──────────▼──────────┐
                                              │  @openrai/nano-core │
                                              │  (separate repo,    │
                                              │   published to npm) │
                                              └─────────────────────┘
```

### Dual-SDK Strategy

- **`@openrai/nano-core`** — Protocol engine. NanoClient, NanoAddress, NanoAmount, WorkProvider, TransportFallback. Targets wallet devs, exchange engineers. Separate repo, published to npm.
- **`@openrai/raiflow-sdk`** — Business runtime. RaiFlowClient wrapping the runtime REST API. Targets SaaS devs, AI agent builders. Lives in this monorepo. Depends on `@openrai/nano-core: ^1.0.0` and `@openrai/model: workspace:*`.

**Symmetric DevEx principle:** Both SDKs share `NanoAmount`, `NanoAddress`, identical `.initialize()` patterns. Zero mental whiplash when graduating between SDKs.

### Runtime HTTP API (9 endpoints)

```
GET    /health
POST   /invoices              — create invoice (Idempotency-Key header)
GET    /invoices              — list invoices (?status=)
GET    /invoices/:id          — get invoice
POST   /invoices/:id/cancel   — cancel invoice
GET    /invoices/:id/payments — list payments for invoice
GET    /invoices/:id/events   — list events for invoice (?after=<eventId>)
POST   /webhooks              — register webhook endpoint
GET    /webhooks              — list endpoints
DELETE /webhooks/:id          — remove endpoint
```

### Event Vocabulary (frozen)

```
invoice.created    — new payment expectation
payment.confirmed  — confirmed Nano send matched to invoice
invoice.completed  — invoice fully paid
invoice.expired    — validity window ended
invoice.canceled   — intentionally closed
```

### Key Design Decisions

- **Observe first** — keyless observation, no fund custody initially
- **Confirmed payment first** — only confirmed send blocks become Payment records
- **Idempotency everywhere** — InvoiceStore.create has idempotency key, PaymentStore.getByBlockHash dedup
- **At-least-once webhook delivery** — HMAC-SHA256 signing, exponential backoff retry (5 attempts)
- **Framework-agnostic HTTP** — web-standard Request/Response, runs on Node/Deno/Bun/Workers
- **Completion policies** — `at_least` (default, `>=` check) and `exact` (`===` check). No `any` — use `at_least` with `expectedAmountRaw: "1"` for donation jars
- **Event replay** — per-invoice via `?after=<eventId>` cursor on `GET /invoices/:id/events`. Global event log deferred

---

## Dependency Graph

```
Phase 0 ──► Phase 1 (DONE ✓) ──► Phase 5 (Examples) [UNBLOCKED]
                                  │
                                  ├──► Phase 2 (RFCs)
                                  │
                                  └──► Phase 3 (Persistence) ──► Phase 4 (Observability)
                                                                    │
                                                                    └──► Phase 6 (Integration)
```

**Critical path:** Phase 1 → Phase 5 (developer-facing, unblocks adoption)
**Parallel track:** Phase 2 (RFCs) and Phase 3 (Persistence) can run alongside Phase 5

---

## Phase Status

### Phase 1 — SDK HTTP Client [DONE ✓]

- [x] Add `CompletionPolicy` type and `completionPolicy` field to Invoice in model
- [x] Extend `EventStore.listByInvoice` with optional `after` parameter in model
- [x] Update runtime completion check to branch on policy (`at_least` vs `exact`)
- [x] Implement cursor filtering in in-memory EventStore
- [x] Parse `completionPolicy` in POST /invoices, parse `after` in GET /invoices/:id/events
- [x] Implement RaiFlowClient HTTP core (fetch-based, baseUrl + apiKey config)
- [x] Implement InvoicesResource (create with completionPolicy, get, list, cancel, listPayments, listEvents with after)
- [x] Add WebhooksResource (create, list, delete)
- [x] Add webhook verification helper (re-export from @openrai/webhook)
- [x] Update index.ts exports (client, resources, model re-exports, verification)
- [x] Add tests for exact policy, cursor pagination, SDK HTTP client

### Phase 2 — RFC Advancement & Drafting [PENDING]

- [ ] Advance RFC 0001 to Accepted
- [ ] Advance RFC 0002 to Accepted
- [ ] Advance RFC 0003 to Accepted
- [ ] Draft RFC 0004 — SDK Architecture (re-export mandate, REST client, auth, versioning)
- [ ] Draft RFC 0005 — nano-core Integration (separate repo, npm publish, optional transport interface)
- [ ] Draft RFC 0006 — Persistence Strategy (SQLite first, adapter contract, event log)

### Phase 3 — Persistence [PENDING]

- [ ] Create store contract test suite
- [ ] Implement SQLite adapter (better-sqlite3)
- [ ] SQLite schema: `completion_policy` column on invoices, index on `(invoice_id, id)` for event cursor queries
- [ ] SQLite webhook endpoint store
- [ ] Add `createSqliteRuntime(dbPath)` factory
- [ ] Run contract tests against SQLite
- [ ] Add `RAIFLOW_DB_PATH` env var to main.ts

### Phase 4 — Observability [PENDING]

- [ ] Define Logger interface in model
- [ ] Create console logger (structured JSON)
- [ ] Replace console.log in webhook delivery (add correlation IDs)
- [ ] Inject logger into Runtime
- [ ] Inject logger into Watcher

### Phase 5 — Examples [DONE ✓]

- [x] Complete webhook-consumer example
- [x] Complete Express API example
- [x] Complete Next.js checkout demo

### Phase 6 — Integration Testing & Deployment [PENDING]

- [ ] Docker Compose for test environment
- [ ] Integration tests against Nano test network
- [ ] Deployment documentation

---

## Open Questions

- **Clock source:** System clock is non-monotonic. Acceptable for single-instance; NTP dependency for multi-instance.
- **Watcher ↔ nano-core:** Watcher should NOT adopt nano-core's full client (observe mode doesn't need frontier management). Optional `NanoRpcTransport` interface for transport fallback only.
