# Architectural Review 0 — Schema, Routes, and Cutover

**Purpose:** Schema table list, route rollout order, and cutover checklist for the v2 implementation.  
**Last updated:** 2026-04-01

---

## Migration 001 — Table List

### Core Tables

```sql
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- open | completed | expired | canceled
  pay_address TEXT NOT NULL UNIQUE,
  expected_amount_raw TEXT NOT NULL,
  received_amount_raw TEXT NOT NULL DEFAULT '0',
  memo TEXT,
  metadata TEXT,                  -- JSON
  idempotency_key TEXT UNIQUE,
  expires_at TEXT,
  completed_at TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completion_policy TEXT NOT NULL DEFAULT '{"type":"at_least"}'
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  status TEXT NOT NULL,           -- pending | confirmed | failed
  block_hash TEXT NOT NULL UNIQUE,
  sender_address TEXT,
  amount_raw TEXT NOT NULL,
  confirmed_at TEXT,
  detected_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,            -- managed | watched
  address TEXT NOT NULL UNIQUE,
  label TEXT,
  balance_raw TEXT NOT NULL DEFAULT '0',
  pending_raw TEXT NOT NULL DEFAULT '0',
  frontier TEXT,
  representative TEXT,
  derivation_index INTEGER,       -- NULL for watched accounts
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sends (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  destination TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued | published | confirmed | failed
  block_hash TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  published_at TEXT,
  confirmed_at TEXT
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,   -- invoice | payment | account | send | block
  data TEXT NOT NULL             -- JSON
);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  event_types TEXT NOT NULL,     -- JSON array of event type filters
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  event_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,          -- pending | success | failed
  response_code INTEGER,
  response_body TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);
```

### Operational Tables

```sql
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,          -- scope-prefixed: "invoice:<key>" | "send:<key>"
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE account_frontiers (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  frontier TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE published_blocks (
  block_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  published_at TEXT NOT NULL
);

CREATE TABLE pending_receivables (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  block_hash TEXT NOT NULL,
  amount_raw TEXT NOT NULL,
  source_account TEXT,
  detected_at TEXT NOT NULL,
  received_at TEXT,
  PRIMARY KEY (account_id, block_hash)
);
```

### Indexes

```sql
CREATE INDEX idx_events_resource ON events(resource_type, resource_id, id);
CREATE INDEX idx_events_type ON events(type, id);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_payments_invoice ON payments(invoice_id, id);
CREATE INDEX idx_payments_block_hash ON payments(block_hash);
CREATE INDEX idx_sends_account ON sends(account_id, id);
CREATE INDEX idx_sends_idempotency ON sends(idempotency_key);
CREATE INDEX idx_invoices_pay_address ON invoices(pay_address);
CREATE INDEX idx_invoices_idempotency ON invoices(idempotency_key);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_webhook_deliveries_event ON webhook_deliveries(event_id);
CREATE INDEX idx_pending_receivables_account ON pending_receivables(account_id, received_at);
```

---

## Route Rollout Order

Build routes in this order. Each group depends on the previous.

**Group 1 — Infrastructure (no dependencies)**
```
GET /health
```

**Group 2 — Events (requires storage + events package)**
```
GET /v1/events
```

**Group 3 — Webhooks (requires events for delivery)**
```
POST   /v1/webhooks
GET    /v1/webhooks
DELETE /v1/webhooks/:id
```

**Group 4 — Accounts (requires custody + storage)**
```
POST   /v1/accounts
GET    /v1/accounts
GET    /v1/accounts/:id
PATCH  /v1/accounts/:id
DELETE /v1/accounts/:id
```

**Group 5 — Watch (same dependencies as accounts)**
```
POST   /v1/watch
GET    /v1/watch
DELETE /v1/watch/:account
```

**Group 6 — Work and Publish (requires rpc + custody)**
```
POST   /v1/work/generate
POST   /v1/publish
```

**Group 7 — Sends (requires custody + accounts + send store)**
```
POST   /v1/accounts/:id/send
```

**Group 8 — Invoices (final, requires all other domains)**
```
POST   /v1/invoices
GET    /v1/invoices
GET    /v1/invoices/:id
POST   /v1/invoices/:id/cancel
GET    /v1/invoices/:id/payments
```

---

## Cutover Checklist

When the v2 implementation reaches feature parity with the prototype:

### Pre-cutover
- [ ] All M1–M4 acceptance criteria pass
- [ ] `pnpm -r build` passes
- [ ] `pnpm -r test` passes
- [ ] API key auth enforced on all mutating endpoints
- [ ] Example READMEs updated to reference v2 API
- [ ] Site docs updated to reference v2 capabilities
- [ ] SDK rebuilt against v2 API

### Cutover
- [ ] Prototype packages (`packages/watcher`, old runtime logic) removed from workspace
- [ ] Old in-memory stores no longer imported anywhere
- [ ] `packages/runtime/src/runtime.ts` rewritten to use new package graph
- [ ] `packages/runtime/src/main.ts` rewritten to use `packages/config`
- [ ] `packages/runtime/src/handler.ts` rewritten to match new v2 route surface

### Post-cutover
- [ ] Docs reflect v2 as current, prototype era as historical
- [ ] No public-facing doc presents observe-mode as the core identity
- [ ] Integration test suite covers send, receive, publish, invoice completion, sweep
- [ ] Restart recovery tested: daemon restart does not lose invoice or payment state

---

## Prototype Deprecation Map

| Prototype file/folder | Treatment |
|---|---|
| `packages/watcher/` | Remove after `rpc` package replaces its function |
| `packages/runtime/src/runtime.ts` | Rewrite — current invoice/payment matching logic is reference, not base |
| `packages/runtime/src/stores.ts` | Retire in-memory stores after `storage` package is complete |
| `packages/runtime/src/main.ts` | Rewrite to use `config` package |
| `packages/runtime/src/handler.ts` | Rewrite to match new v2 route surface |
| `packages/runtime/src/__tests__/` | Replace with tests against new domain services |

The prototype served its purpose: proving the concept and identifying the architecture. The production implementation starts clean.
