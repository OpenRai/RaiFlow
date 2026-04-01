# RaiFlow

RaiFlow is a self-hostable Nano runtime for application developers.

It is meant to sit between your app and one or more Nano nodes so your application code does not need to own RPC quirks, account tracking, block publishing, signing flow, webhook delivery, or payment-event plumbing.

## Status

RaiFlow is in the middle of a v2 rebuild.

What is true today:

- The v2 foundation packages exist and build: `config`, `storage`, `events`, `rpc`, `custody`
- The daemon boots from `raiflow.yaml`
- SQLite migrations run on startup
- The event store and event bus are implemented
- The RPC package has multi-node client/failover primitives
- The custody package has seed loading, derivation, signing, and work-generation primitives
- The current HTTP runtime is still partly prototype-era in its domain behavior and route surface

What is not true yet:

- The wallet domain is not fully wired through the runtime API
- The invoice domain has not yet been fully rebuilt on top of the new custody/storage stack
- The documented v2 route surface is not fully implemented end-to-end
- Hardening work like full auth enforcement, restart recovery, and integration tests is still ahead

If you are evaluating the repository today, the safest reading is:

> The architecture direction is set, the base packages are real, and the domain services are still being connected.

## What RaiFlow Is For

RaiFlow aims to provide one runtime for two related jobs:

- Receiving Nano payments for an application
- Operating Nano accounts programmatically

That means two domains in one system:

- **Invoice domain**: create payment expectations, detect matching incoming payments, manage invoice lifecycle, and eventually sweep funds
- **Wallet domain**: manage derived accounts, watch external accounts, send funds, publish pre-signed blocks, and generate work

Both domains share the same storage, event model, RPC layer, and custody engine.

## What It Is Not

RaiFlow is not:

- a consumer wallet UI
- a hosted gateway or SaaS product
- a Nano node
- a block explorer
- a fiat payments platform
- an e-commerce framework

## Current Runtime Surface

The runtime currently exposes a limited, transitional HTTP surface centered on the earlier invoice prototype:

- `GET /health`
- `POST /invoices`
- `GET /invoices`
- `GET /invoices/:id`
- `POST /invoices/:id/cancel`
- `GET /invoices/:id/payments`
- `GET /invoices/:id/events`
- `POST /webhooks`
- `GET /webhooks`
- `DELETE /webhooks/:id`

This should be treated as in-progress rather than final API design.

## Target Architecture

The v2 direction is a package-based runtime with clear boundaries:

```text
YOUR APP -> RAIFLOW RUNTIME -> NANO NODE(S)
              |
              |- invoice domain
              |- wallet domain
              |- event system
              |- custody engine
              `- RPC abstraction
```

Core packages:

```text
apps/site/            documentation site
packages/
  model/              canonical types and contracts
  config/             YAML config loader with env resolution
  storage/            SQLite adapter and migrations
  rpc/                Nano RPC + WebSocket primitives
  events/             event bus and persisted event access
  custody/            derivation, signing, PoW, frontier-related logic
  runtime/            HTTP runtime and orchestration
  webhook/            webhook signing and delivery
  raiflow-sdk/        typed JS/TS client
examples/             reference integrations
rfcs/                 architecture decisions
docs/                 progress and implementation notes
```

## Design Constraints

These are deliberate project constraints, not marketing claims:

- self-hostable first
- idempotency on mutating operations
- persist-first events
- one runtime for invoice and wallet domains
- multi-node RPC instead of single-node dependence
- namespace separation for invoice and managed-account derivation
- framework-agnostic runtime API built on web `Request`/`Response`
- Nano protocol primitives delegated to `@openrai/nano-core`

## Running The Current Code

1. Install dependencies:

```bash
pnpm install
```

2. Create a config file:

```bash
cp raiflow.yaml.example raiflow.yaml
```

3. Fill in the required environment variables referenced by `raiflow.yaml`

4. Build the workspace:

```bash
pnpm -r build
```

5. Run tests:

```bash
pnpm -r test
```

6. Start the runtime:

```bash
pnpm --filter @openrai/runtime start
```

## Repository Truth Sources

If you want the current state rather than the intended end state, read these first:

- `docs/progress.md` — current implementation frontier
- `ROADMAP.md` — milestone map
- `rfcs/0001-project-framing.md` — project framing and scope
- `rfcs/0003-event-model.md` — current v2 resource/event model

## Blunt Assessment

RaiFlow is no longer just an observe-mode prototype, but it is not yet a finished production runtime either.

The repo already contains the foundation needed for that runtime:

- typed config loading
- SQLite persistence
- migrations
- persisted events
- RPC primitives
- custody primitives

What remains is the hard part that matters most to users: finishing the domain services and exposing them coherently through the runtime API.
