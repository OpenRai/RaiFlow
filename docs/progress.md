# RaiFlow Progress

**Purpose:** Bootstrap document for new coding sessions. Contains current architecture context, active milestone, and immediate next steps.
**Last updated:** 2026-05-12 (account sync resilience fix)

---

## Architecture at a Glance

```
YOUR APP ──► RAIFLOW RUNTIME ──► NANO NODE(S)
                │
                ├── INVOICE DOMAIN     (get paid)
                │       └── create invoice → detect payment → complete/sweep
                │
                ├── WALLET DOMAIN      (operate a wallet)
                │       └── managed accounts · watched accounts · send · publish
                │
                ├── UNIFIED EVENT SYSTEM
                │       └── invoice.* + payment.* + account.* + send.* + block.*
                │
                ├── CUSTODY ENGINE     (seed · derivation · signing · PoW · rep)
                │
                └── RPC ABSTRACTION    (multi-node · failover · WS · confirmations)
```

### Package Map

```
packages/
  model/       — canonical types, schemas, shared contracts
  config/      — YAML loader, env resolution, typed config
  storage/     — store contracts, SQLite driver, migrations
  rpc/         — multi-node RPC, WS, failover, confirmation tracking
  events/      — event bus, persistence, querying
  custody/     — seed, derivation, signing, PoW, frontier ops
  runtime/     — HTTP API, services, orchestration
  webhook/     — HMAC signing, delivery engine
  raiflow-sdk/ — typed JS/TS client
```

### nano-core Boundary

`@openrai/nano-core` (separate repo, published to npm) provides Nano protocol primitives: `NanoAmount`, `NanoAddress`, `NanoClient`, `WorkProvider`. RaiFlow owns orchestration, storage, event routing, and application-level semantics.

---

## Active Milestone

**M2 — RPC + Custody** — ✅ **Complete**

- RPC pool with multi-node failover, JSON-RPC client, WebSocket client for confirmations
- Custody engine with seed management, BIP32 derivation, block signing, PoW generation via nano-core

---

**M3 — Wallet Domain** — *in progress*

Building in order:
1. ✅ Accounts service (managed + watched)
2. ✅ Sends service (idempotent, state machine)
3. ✅ Account Watch Pool & Real-Time Event Fan-Out
4. Publish service (pre-signed blocks)
5. Work generation API

Current frontier:
- Account and Send resources are exposed through the runtime HTTP API and the `@openrai/raiflow-sdk` package.
- `SendOrchestrator` drives the non-anemic send lifecycle: `queued` → `published` → `confirmed`/`failed`.
- The runtime wires `accountStore`, `sendStore`, `custodyEngine`, `rpcPool`, and `Watcher` together in `main.ts`.
- `Watcher` now forwards confirmations for both incoming (recipient match) and outgoing (sender match) blocks.
- `handleConfirmedBlock` transitions sends from `published` to `confirmed` by block hash and updates account balances on incoming receives.
- **Account Watch Pool** (`AccountStateSync`) performs initial sync and 30s periodic reconciliation for all watched accounts, emitting `AccountEvent`s. Initial sync now defends against transient RPC failures (logs warning, continues startup) and spaces bulk sync calls with a 250ms delay to avoid rate-limit cooldowns.
- **SubscriptionManager** deduplicates SSE connections and fans out `AccountEvent`s to subscribed clients.
- **SSE stream** (`GET /api/accounts/stream`) with `X-Raiflow-Stream-Id` header, plus `POST/DELETE /api/accounts/:id/watch` for dynamic subscribe/unsubscribe.
- **SDK** adds `accounts.watch()` returning an `AsyncIterable<AccountEvent>`, backed by a shared `SseConnection` with auto-reconnect.
- Container image (`ghcr.io/openrai/raiflow`), Docker Compose example, and deployment quickstart are implemented. The runtime auto-generates and enforces API keys.
- Next transport follow-up is to persist and surface infrastructure events like `rpc.connected` and `rpc.failover` through the runtime once the legacy event adapter no longer constrains non-invoice event types.

Exit criterion: can create a managed account, derive addresses, send XNO, query send status.

---

## What Is Already True

These decisions are settled and should not be re-litigated without strong new evidence:

1. **Dual-domain, one runtime** — Invoice and wallet domains coexist in the same instance, sharing storage, RPC, custody, and events.
2. **Managed + watched + pre-signed** — Three custody modes coexist. Managed: RaiFlow holds keys. Watched: external. Pre-signed: air-gapped with RaiFlow publishing.
3. **Idempotency mandatory on all mutating operations** — especially sends. No idempotency key = rejection.
4. **Persist-first events** — events are written before delivery is attempted. Delivery failure does not lose the event.
5. **Multi-node RPC failover** — single-node is not acceptable for production.
6. **Derivation namespace separation** — invoice addresses and managed wallet accounts derive from non-overlapping index ranges from the same seed.
7. **Deterministic address mapping** — if any string or external identifier participates in address selection, the same input must resolve to the same address across restarts unless a persisted mapping says otherwise.
8. **`nano-core` for protocol primitives** — RaiFlow does not reimplement Nano address encoding, amount math, or block construction from scratch.
9. **SQLite default, PostgreSQL later** — single-file zero-dependency default, swap via adapter.
10. **YAML config with `env:` references** — no hardcoded values, no surprising runtime env var injection.
11. **Web standard Request/Response** — framework-agnostic HTTP handler. No Express/Hono/Fastify dependency in the core runtime.
12. **Startup mode enforcement** — `RAIFLOW_MODE` is required at boot (`custodial` or `non-custodial`). Mode gates which features are available. Custodial mode requires custody config.
13. **API key is developer-provided** — `RAIFLOW_API_KEY` is required. No auto-generation, no hidden files. The developer picks their own key.
14. **PoW is invisible to the developer** — RaiFlow absorbs work generation, signing, and frontier management. Low-level escape hatches (`WorkResource`, `BlocksResource`) exist only for non-custodial pre-signed flows.

---

## Open Questions

| Question | Current position | Notes |
|---|---|---|
| WebSocket auth mechanism | Bearer token in `Authorization` header | May add subprotocol or ticket auth later |
| Event total ordering guarantee | Best-effort per resource | Global total ordering deferred |
| Auto-sweep timing | Immediate on completion | Future: configurable delay |
| Overpayment on `exact` policy | Do not complete | Developer handles manually |
| Multiple simultaneous sweeps | Not supported v1 | Queue-based, one at a time |
