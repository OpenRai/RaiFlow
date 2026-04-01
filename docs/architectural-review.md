# Architectural Review

**Purpose:** Implementation blueprint and package dependency map for v2.  
**Last updated:** 2026-04-01

---

## Package Map

```
packages/
  model/       — canonical types, schemas, shared contracts
  config/      — YAML loader, env resolution, typed config
  storage/     — store contracts, SQLite driver, migrations
  rpc/         — multi-node RPC, WebSocket, failover, confirmation tracking
  events/      — event bus, persistence, querying
  custody/     — seed, derivation, signing, PoW, frontier ops
  runtime/     — HTTP API, services, orchestration
  webhook/     — HMAC signing, delivery engine
  raiflow-sdk/ — typed JS/TS client
```

### Dependency Graph

```
model ─────────────────────────────────────────────────────────────┐
                                                              │
config ─────────────────────────────────────────────────────────┤
                                                              │
storage ──► model ─────────────────────────────────────────────┤
                                                              │
events ───► model ─────────────────────────────────────────────┤
                                                              │
rpc ──────► model ────────────────────────────────────────────┤
                                                              │
custody ──► model ─────────────────────────────────────────────┤
           │                                                  │
           └──► rpc ──► events ──► storage                     │
                      (custody emits events)                   │
                                                              │
runtime ──► model ────────────────────────────────────────────┤
           ├──► config                                          │
           ├──► storage                                         │
           ├──► events                                         │
           ├──► custody ──► rpc                                │
           └──► webhook                                         │
                                                              │
webhook ───► model ────────────────────────────────────────────┤
                                                              │
raiflow-sdk ──► model ─────────────────────────────────────────┘
```

---

## nano-core Boundary

`@openrai/nano-core` (separate repo, npm: `^1.0.0`) provides:

- `NanoAmount` — amount arithmetic and unit conversion
- `NanoAddress` — address encoding and validation
- `NanoClient` — low-level RPC transport
- `WorkProvider` — PoW generation abstraction

RaiFlow owns:
- Seed management and key derivation
- Derivation index management and namespace separation
- Account frontier tracking
- Send/receive/change orchestration
- RPC failover and connection management
- Event persistence and routing
- Application-level state management

---

## Derivation Namespaces

Invoice addresses and managed wallet accounts use non-overlapping BIP-44 derivation ranges from the same seed:

```
seed
├── invoice addresses:   index 0x00000000 – 0x7FFFFFFF
└── managed accounts:    index 0x80000000 – 0xFFFFFFFF
```

This prevents collisions and makes address purpose distinguishable from the derivation index alone.

Address assignment must also be deterministic. If RaiFlow derives or selects an address based on any application string, external identifier, or idempotency key, the same input must resolve to the same address across restarts unless an explicit persisted remapping exists.

---

## Store Interfaces

Each store is a typed interface in `model`. Implementations are swappable.

```
InvoiceStore
  create(invoice, idempotencyKey?) → Invoice
  get(id) → Invoice | undefined
  list(filter?) → Invoice[]
  update(id, patch) → Invoice
  getByPayAddress(address, status?) → Invoice[]
  getByIdempotencyKey(key) → string | undefined

PaymentStore
  create(payment) → Payment
  get(id) → Payment | undefined
  getByBlockHash(hash) → Payment | undefined
  listByInvoice(invoiceId) → Payment[]

AccountStore
  create(account) → Account
  get(id) → Account | undefined
  getByAddress(address) → Account | undefined
  list(filter?) → Account[]
  update(id, patch) → Account

SendStore
  create(send) → Send
  get(id) → Send | undefined
  listByAccount(accountId) → Send[]
  getByIdempotencyKey(key) → Send | undefined
  update(id, patch) → Send

EventStore
  append(event) → void
  list(filter?) → RaiFlowEvent[]   // { after?, type?, resourceType?, resourceId?, limit? }

WebhookEndpointStore
  create(endpoint) → WebhookEndpoint
  get(id) → WebhookEndpoint | undefined
  list() → WebhookEndpoint[]
  delete(id) → boolean
  getByEventType(eventType) → WebhookEndpoint[]
```

---

## HTTP API Shape

All endpoints under `/v1`. Auth via `Authorization: Bearer <apiKey>` header on all non-health endpoints.

### Health

```
GET /health → { status: 'ok' }
```

### Events

```
GET /v1/events?after=<cursor>&type=<filter>&resourceType=<type>&resourceId=<id>&limit=50
```

### Webhooks

```
POST   /v1/webhooks           — register endpoint
GET    /v1/webhooks           — list endpoints
DELETE /v1/webhooks/:id       — remove endpoint
```

### Accounts

```
POST   /v1/accounts           — create managed account
GET    /v1/accounts           — list accounts
GET    /v1/accounts/:id       — get account
PATCH  /v1/accounts/:id       — update label, representative
DELETE /v1/accounts/:id       — delete account (zero balance only)
```

### Watch

```
POST   /v1/watch              — start watching an external account
GET    /v1/watch              — list watched accounts
DELETE /v1/watch/:account      — stop watching
```

### Work and Publish

```
POST   /v1/work/generate      — generate PoW
POST   /v1/publish            — publish pre-signed block
```

### Sends

```
POST   /v1/accounts/:id/send  — send from managed account
```

### Invoices

```
POST   /v1/invoices           — create invoice
GET    /v1/invoices           — list invoices
GET    /v1/invoices/:id       — get invoice
POST   /v1/invoices/:id/cancel — cancel invoice
GET    /v1/invoices/:id/payments — list payments
```

---

## Error Model

All errors follow a consistent envelope:

```typescript
interface RaiFlowError {
  error: {
    message: string   // Human-readable
    code: string      // Machine-readable, stable across versions
  }
}
```

Common error codes:
- `unauthorized` — missing or invalid API key
- `not_found` — resource does not exist
- `conflict` — state conflict (e.g. delete non-empty account)
- `bad_request` — invalid input
- `internal_error` — unexpected server error

---

## Configuration Shape

```yaml
# raiflow.yaml
daemon:
  host: "127.0.0.1"
  port: 7400
  apiKey: "env:RAIFLOW_API_KEY"

nano:
  nodes:
    - rpc: "http://localhost:7076"
      ws: "ws://localhost:7078"
      priority: 1
    - rpc: "http://backup:7076"
      ws: "ws://backup:7078"
      priority: 2

custody:
  seed: "env:RAIFLOW_SEED"
  representative: "nano_1rep..."

invoices:
  defaultExpirySeconds: 3600
  autoSweep: true
  sweepDestination: "treasury"

storage:
  driver: "sqlite"
  path: "./raiflow.db"

webhooks:
  - url: "https://myapp.com/hooks/raiflow"
    secret: "env:WEBHOOK_SECRET"
    events: ["*"]

logging:
  level: "info"    # debug | info | warn | error
  format: "json"   # json | pretty
```

---

## Implementation Exit Criteria

Each milestone is complete when:

**M1 (Foundation)**
- `raiflow` starts from `raiflow.yaml`
- Migrations run automatically
- Auth rejects unauthenticated requests
- `GET /health` returns `{"status":"ok"}`
- `GET /v1/events` returns an empty event log

**M2 (RPC + Custody)**
- Multi-node failover works with a dead primary node
- WS reconnect fires after disconnect
- A managed account can be derived deterministically from seed
- A valid block can be signed and published

**M3 (Wallet Domain)**
- Managed and watched accounts coexist
- Send with duplicate idempotency key is rejected
- Send without idempotency key is rejected
- Pre-signed publish emits `block.published` and `block.confirmed`

**M4 (Invoice Domain)**
- Invoice pay addresses are derived and unique
- Payment detection and confirmation transitions work
- `exact` completion policy does not complete on overpayment
- Sweep sends a valid block from the pay address to treasury
