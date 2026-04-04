# RFC 0002 — Runtime Architecture

Note on naming: the file path still says `0002-observe-mode.md` for continuity, but this RFC no longer describes the old observe-mode architecture. It describes the v2 runtime architecture.

This RFC describes the internal architecture of the RaiFlow runtime: package boundaries, how the two domains fit together, and the infrastructure shared between them.

---

## System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    YOUR APPLICATION                          │
│       (e-commerce, wallet, bot, agent, SaaS, POS)           │
└──────────────────────────┬──────────────────────────────────┘
                           │  raiflow-sdk
                           │  REST + WebSocket
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     RAIFLOW DAEMON                          │
│                                                             │
│  ┌──────────────────┐  ┌────────────────────────────────┐ │
│  │  INVOICE DOMAIN  │  │  WALLET DOMAIN                   │ │
│  │  Create invoice  │  │  Create / manage accounts        │ │
│  │  Match payments  │  │  Watch external accounts         │ │
│  │  Track lifecycle │  │  Send XNO                        │ │
│  │  Apply policies  │  │  Track balances                  │ │
│  │  Sweep to treasury│ │  Publish pre-signed blocks       │ │
│  └────────┬─────────┘  └──────────────┬───────────────────┘ │
│           │                           │                     │
│  ┌────────┴───────────────────────────┴───────────────────┐ │
│  │              UNIFIED EVENT SYSTEM                        │ │
│  └────────┬───────────────────────────┬───────────────────┘ │
│           │                           │                     │
│  ┌────────┴───────────────────────────┴───────────────────┐ │
│  │              CUSTODY ENGINE                            │ │
│  │  Seed storage · Key derivation · Signing · PoW · Rep  │ │
│  └────────┬───────────────────────────────────────────────┘ │
│           │                                                 │
│  ┌────────┴───────────────────────────────────────────────┐ │
│  │              RPC ABSTRACTION                             │ │
│  │  Multi-node failover · WS reconnect · Retry · Timeout   │ │
│  └────────┬───────────────┬───────────────────────────────┘ │
└───────────┼───────────────┼─────────────────────────────────┘
       ┌────┴────┐    ┌─────┴─────┐
       │ Node A  │    │  Node B   │
       └─────────┘    └───────────┘
```

---

## Package Responsibilities

### `@openrai/model`

Canonical public types, schemas, and shared contracts only. No application logic.

- Resource types: `Invoice`, `Payment`, `Account`, `Send`, `RaiFlowEvent`, `WebhookEndpoint`
- Request/response DTOs
- Store interfaces
- Event type enums and discriminated unions
- Shared validation schemas

### `@openrai/config`

Loads and validates `raiflow.yml`.

- Parse YAML
- Resolve `env:VARIABLE_NAME` references
- Validate required fields and types
- Produce typed `RaiFlowConfig`

### `@openrai/storage`

Persistent data access layer.

- Store interfaces (invoice store, payment store, account store, send store, event store, webhook store)
- SQLite driver (default)
- Forward-only migration runner
- Transaction helpers

### `@openrai/rpc`

Nano node communication.

- Multi-endpoint HTTP RPC failover across configured `nano.rpc` URLs
- WebSocket connection manager with reconnect/backoff
- Request timeout and retry
- Confirmation subscription routing
- Infrastructure events: `rpc.connected`, `rpc.disconnected`, `rpc.failover`

### `@openrai/events`

Unified event system.

- Persist-first event append
- In-process event bus (fire-and-forget local subscribers)
- Cursor-based global event queries
- Event filtering helpers

### `@openrai/custody`

Key and transaction management.

- Seed loading and decryption
- BIP-44 style key derivation
- Namespace separation: invoice addresses `0x00000000–0x7FFFFFFF`, managed accounts `0x80000000–0xFFFFFFFF`
- Deterministic derivation invariant: the same derivation input must always resolve to the same address; if an application-level string is used to choose an invoice address, that mapping must be deterministic or explicitly persisted
- Block construction: send, receive, change representative
- Block signing
- PoW generation abstraction (delegates to `@openrai/nano-core` `WorkProvider`)
- Representative management
- Frontier tracking
- Auto-receive pipeline

### `@openrai/runtime`

HTTP API and service orchestration.

- API key authentication
- Request ID and structured error middleware
- Invoice service
- Account service
- Send service
- Publish service
- Webhook management service
- Startup: wires config → storage → rpc → custody → events → services

### `@openrai/webhook`

Webhook delivery.

- HMAC-SHA256 payload signing
- Delivery engine with exponential backoff retry
- Per-endpoint delivery attempt logging (persisted via storage)
- Signature verification helper for consumers

### `@openrai/raiflow-sdk`

Typed JavaScript/TypeScript client.

- REST resource classes for every API surface
- WebSocket subscription client
- Event polling helpers
- Public model type re-exports

---

## Runtime HTTP API

Prefix: `/v1`

```
GET    /health
GET    /v1/events           — global event log (?after=&type=&limit=)
POST   /v1/webhooks
GET    /v1/webhooks
DELETE /v1/webhooks/:id
POST   /v1/accounts
GET    /v1/accounts
GET    /v1/accounts/:id
PATCH  /v1/accounts/:id
DELETE /v1/accounts/:id
POST   /v1/watch
GET    /v1/watch
DELETE /v1/watch/:account
POST   /v1/work/generate
POST   /v1/publish
POST   /v1/accounts/:id/send
POST   /v1/invoices
GET    /v1/invoices
GET    /v1/invoices/:id
POST   /v1/invoices/:id/cancel
GET    /v1/invoices/:id/payments
```

---

## Custody Engine and nano-core

`@openrai/custody` uses `@openrai/nano-core` for:

- Nano address encoding and validation
- `NanoAmount` and amount arithmetic
- `WorkProvider` for PoW generation
- Low-level block construction helpers

`@openrai/custody` owns:

- Seed storage and decryption
- Derivation index management
- Account frontier tracking
- Send/receive/change orchestration
- Representative setting

RaiFlow does not reimplement Nano protocol logic. It delegates to nano-core and orchestrates.

---

## Integration Modes

Both modes coexist in the same RaiFlow instance simultaneously. Not startup configuration toggles — capabilities that live side by side.

**Managed Custody** — RaiFlow holds the seed.

```typescript
const account = await raiflow.accounts.create({ label: 'treasury' })
// account.type === 'managed'
// RaiFlow owns the keys. Auto-receives. Can send on command.
```

**External Custody** — You hold the keys.

```typescript
const watched = await raiflow.watch.create({
  account: 'nano_1external...',
  label: 'cold-storage',
})
// watched.type === 'watched'
// RaiFlow monitors, emits events, but cannot sign for this account.
```

**Pre-signed Publishing** — Air-gapped signing.

```typescript
const result = await raiflow.publish({
  block: mySignedBlock,
  watchConfirmation: true,
})
// RaiFlow handles RPC failover, retry, confirmation tracking, event emission.
```

---

## Sweep Mechanics

When an invoice completes with `autoSweep` enabled:

1. RaiFlow auto-receives all pending blocks on the invoice's pay address
2. RaiFlow constructs a send block from the pay address to the sweep destination
3. The send is tracked through the same custody engine as wallet domain sends
4. An `invoice.swept` event fires on success

Invoice addresses are transient collection points. Funds consolidate into treasury exactly like a cash register being emptied into a safe.
