# Runtime

This page describes the runtime as it exists today, not only as it is intended to look later.

## Current State

The runtime boots from `raiflow.yml`, runs SQLite migrations, and exposes the
`/v1` commerce API through the typed SDK. It persists business events and
webhook delivery jobs, and recovers send and receive operations after restart.

## Available Now

Current HTTP route families include:

```text
GET    /health/live
GET    /health/ready
GET    /health/storage
GET    /v1/version
POST   /v1/accounts
GET    /v1/accounts[/:id]
GET    /v1/accounts/:id/deposits
POST   /v1/accounts/:id/sends
POST   /v1/deposits/:depositId/refunds
GET    /v1/deposits/:depositId/refunds
POST   /v1/invoices
GET    /v1/invoices[/:id]
POST   /v1/invoices/:id/cancel
GET    /v1/events
GET    /v1/events/stream
POST   /v1/blocks
POST   /v1/work
POST   /v1/webhooks
GET    /v1/webhooks
DELETE /v1/webhooks/:id
```

For exact request shapes and all resource methods, see the [SDK reference](https://github.com/openrai/raiflow/blob/main/packages/raiflow-sdk/README.md).

## Authentication

The runtime requires an API key at startup and checks Bearer authentication on
protected routes. Bind the service privately and keep the key secret.

## Configuration

Runtime startup uses `raiflow.yml`.

Example shape:

```yaml
daemon:
  host: "0.0.0.0"
  port: 3100
  apiKey: "env:RAIFLOW_API_KEY"

nano:
  rpc: []
  ws: []
  work: []
  # rpc: ["env:NANO_RPC_URL"]
  # ws: ["env:NANO_WS_URL"]
  # work: ["env:NANO_WORK_URL"]

# receiving:
#   minimumAmountXno: "0.000001"

storage:
  driver: "sqlite"
  path: "./raiflow.db"
  maxDatabaseBytes: 1073741824
  maxDepositsPerAccount: 100000
```

RPC endpoint configuration is supplied through `nano.rpc` and environment
overrides. Custodial settings depend on the configured OWS provider.

## Inbound storage budgets

RaiFlow retains deposit, payment, event, webhook, and recovery evidence. It
pauses new inbound persistence when the configured global database byte cap or
per-destination deposit count is reached. Pending transfers remain receivable on
the Nano node; the watcher does not advance recovery past an unpersisted source
send. Raise the configured limit and restart to resume. No historical evidence
is automatically deleted.

Defaults are `storage.maxDatabaseBytes: 1073741824` (1 GiB) and
`storage.maxDepositsPerAccount: 100000`. Override them with
`RAIFLOW_STORAGE_MAX_DATABASE_BYTES` and
`RAIFLOW_STORAGE_MAX_DEPOSITS_PER_ACCOUNT`. `GET /health/storage` reports the
current database footprint and whether any inbound processing is paused.

See the repository `raiflow.yml.example` for the full current example.

## Read With Care

For target architecture, read:

- [RFC 0001](../rfcs/0001-project-framing)
- [RFC 0002](../rfcs/0002-observe-mode)
- [RFC 0003](../rfcs/0003-event-model)

For actual current build state, read:

- [Roadmap](../roadmap)
