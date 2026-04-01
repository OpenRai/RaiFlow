# Runtime

This page describes the runtime as it exists today, not only as it is intended to look later.

## Current State

The runtime currently does these things reliably:

- boots from `raiflow.yaml`
- opens SQLite storage and runs migrations
- wires the event store and event bus
- exposes a small HTTP surface inherited from the earlier invoice prototype

The runtime does not yet expose the full v2 wallet and invoice API described in the RFCs.

## Available Now

Current HTTP routes:

```text
GET    /health
POST   /invoices
GET    /invoices
GET    /invoices/:id
POST   /invoices/:id/cancel
GET    /invoices/:id/payments
GET    /invoices/:id/events
POST   /webhooks
GET    /webhooks
DELETE /webhooks/:id
```

These routes should be treated as transitional. They do not represent the finished v2 surface.

## Planned Runtime Surface

The target runtime adds the missing v2 families:

```text
GET    /v1/events
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

That target is documented in the RFCs and roadmap, but it is not all live yet.

## Authentication

Authentication is part of the intended runtime design, but it is not yet fully enforced across the runtime surface.

Do not assume the current codebase has complete production-grade auth behavior wired end to end.

## Configuration

Runtime startup uses `raiflow.yaml`.

Example shape:

```yaml
daemon:
  host: "0.0.0.0"
  port: 3100
  apiKey: "env:RAIFLOW_API_KEY"

nano:
  nodes:
    - rpc: "env:NANO_RPC_URL"
      ws: "env:NANO_WS_URL"
      priority: 1

custody:
  seed: "env:RAIFLOW_SEED"
  representative: "env:RAIFLOW_REPRESENTATIVE"

storage:
  driver: "sqlite"
  path: "./raiflow.db"
```

See the repository `raiflow.yaml.example` for the full current example.

## Read With Care

For target architecture, read:

- [RFC 0001](../rfcs/0001-project-framing)
- [RFC 0002](../rfcs/0002-observe-mode)
- [RFC 0003](../rfcs/0003-event-model)

For actual current build state, read:

- [Roadmap](../roadmap)
