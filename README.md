> [!IMPORTANT]  
> This project is still under heavy development. The vision is set, but the API & SDK is still not stable. Please don't use for production quite yet. 

# RaiFlow

**RaiFlow** is the **runtime layer** [Nano](https://nano.org/) app developers should have had from the start.

RaiFlow sits **between your app and one or more Nano nodes** and turns that low-level mess into an application-facing runtime.

```text
Your app -(RaiFlow SDK)-> Runtime -(JSON-RPC)-> Nano node(s)
                          |
                          |- invoice domain
                          |- wallet domain
                          |- custody engine
                          |- persisted events
                          `- RPC failover + confirmations
```

![Adnan showing the move from raw Nano JSON-RPC to the RaiFlow runtime layer](docs/images/adnan-before-after-raiflow.jpg)

## The Pitch

Without RaiFlow, applications often ends up owning too much Nano-specific machinery:

- raw JSON-RPC calls
- node failover and reconnect logic
- WebSocket confirmation handling
- account frontier tracking
- work generation and block publish flow
- receivable detection and receive flow
- payment matching and webhook plumbing

*With RaiFlow* (through [its SDK](#typed-client-sdk)) your app talks to a runtime that already understands those concerns:

- create invoices
- operate managed or watched accounts
- send XNO safely with idempotency
- publish pre-signed blocks
- subscribe to persisted events
- deliver webhooks from one place

The idea is simple: you build app logic. RaiFlow carries the Nano runtime logic for you.

Adnan (عدنان), the Nano camel above, is the repo mascot for that shift.

## What RaiFlow IS

RaiFlow is a self-hostable Nano runtime (typically deployed as an app container) for two jobs that instinsically belong together:

- getting paid
- operating a wallet

Those jobs map to two domains in one runtime:

- **Invoice domain**: create payment expectations, detect matching payments, manage lifecycle, and sweep funds
- **Wallet domain**: manage derived accounts, watch external accounts, send funds, publish pre-signed blocks, and generate work

Both domains share the same storage, event system, RPC layer, and custody engine.

RaiFlow, just like a trusty camel, intentionally tries to stay as thin but also _fit_ as possible. It adds orchestration, persistence, event routing, and reliability guarantees. It does not try to become your catalog, checkout, customer database, or business logic layer.

## What it IS NOT

RaiFlow is not:

- a consumer wallet UI
- a hosted gateway or SaaS product
- a Nano node
- a block explorer
- a fiat payments platform
- an e-commerce framework
- something you deploy externally as a public service

## Typed Client SDK

Use `@openrai/raiflow-sdk` when your application talks to RaiFlow over HTTP:

```bash
pnpm add @openrai/raiflow-sdk
```

The SDK provides a typed `RaiFlowClient` with resource classes for accounts, sends, invoices, webhooks, blocks, and work, plus re-exports of all canonical types from `@openrai/model`.

See [`packages/raiflow-sdk/README.md`](packages/raiflow-sdk/README.md) for the full API reference.

## Deployment Quickstart

The fastest way to run RaiFlow is with Docker Compose.

### Quick Start

1. Copy the example compose file (or use the one in the repository root):

```bash
cp docker-compose.yml docker-compose.override.yml
```

2. Edit `docker-compose.override.yml` and set the required environment variables:

```yaml
environment:
  NANO_RPC_URL: "https://rpc.nano.org"
  RAIFLOW_MODE: "custodial"           # or "non-custodial"
  RAIFLOW_API_KEY: "your-secret-key"  # required
```

3. Start the container:

```bash
docker compose up -d
```

RaiFlow will boot, run SQLite migrations, and start in the configured mode.

### Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NANO_RPC_URL` | **Yes** | Nano node RPC endpoint (e.g. `https://rpc.nano.org`) |
| `RAIFLOW_MODE` | **Yes** | `"custodial"` or `"non-custodial"` — see [Modes](#modes) |
| `RAIFLOW_API_KEY` | **Yes** | API key for Bearer auth. You set this yourself. |
| `RAIFLOW_CUSTODY_SEED` | Custodial only | BIP39 seed for managed accounts. |
| `RAIFLOW_CUSTODY_REP` | Custodial only | Default representative for managed accounts. |

### Modes

RaiFlow operates in one of two modes, set at startup via `RAIFLOW_MODE`:

**Custodial mode** — RaiFlow manages keys, derives accounts, signs blocks, and generates PoW. Requires `RAIFLOW_CUSTODY_SEED` and `RAIFLOW_CUSTODY_REP`. This is the full-featured mode where your app delegates all Nano protocol mechanics to the runtime.

**Non-custodial mode** — RaiFlow acts as a relay and monitor. All signing happens client-side. Watched accounts, block publishing, and work generation are available. Managed accounts, sends, and invoices are not — those require custody.

### Persistent Data

The `/data` volume persists the SQLite database (`raiflow.db`) across restarts.

### Port Binding & Security

RaiFlow is designed as an **app-private** service. **Do NOT forward port 3100 to the public internet.** The compose file binds to `127.0.0.1` so only local application code can reach it. The API key authenticates internal service requests, not public traffic.

### Custom Config

For advanced settings (webhooks, auto-sweep, multi-node RPC), mount your own `raiflow.yml`:

```yaml
services:
  raiflow:
    volumes:
      - ./my-raiflow.yml:/app/raiflow.yml:ro
```

## Running The Current Code

1. Install dependencies:

```bash
pnpm install
```

2. Create a config file:

```bash
cp raiflow.yml.example raiflow.yml
```

3. Set the required environment variables:

```bash
export RAIFLOW_MODE=custodial          # or non-custodial
export RAIFLOW_API_KEY=your-secret-key
export NANO_RPC_URL=https://rpc.nano.org
```

4. If using custodial mode, also set:

```bash
export RAIFLOW_CUSTODY_SEED=your-bip39-seed
export RAIFLOW_CUSTODY_REP=nano_1...
```

5. Build the workspace:

```bash
pnpm -r build
```

6. Run tests:

```bash
pnpm -r test
```

7. Start the runtime:

```bash
pnpm --filter @openrai/runtime start
```

## Status

RaiFlow is actively developed. The v2 foundation is solid and the wallet domain is coming online.

| Capability | Status |
|---|---|
| Multi-node RPC with failover | Shipped |
| WebSocket confirmation tracking | Shipped |
| Custody engine (seed, derivation, signing, PoW) | Shipped |
| Persisted event store & bus | Shipped |
| Managed accounts (derive, sign, track) | Shipped |
| Watched accounts (monitor external addresses) | Shipped |
| Sends (idempotent queue → publish → confirm) | Shipped |
| Invoices (create, detect, complete) | Shipped |
| Webhooks (HMAC signed delivery) | Shipped |
| Operator dashboard (SSR) | Shipped |
| Block publish escape hatch | Shipped |
| Work generation escape hatch | Shipped |
| Pre-signed block flows | In progress |
| Restart recovery & hardening | In progress |

What is not fully wired yet:

- The invoice domain is operational but still runs partially on the legacy storage adapter while being migrated to the new event-native stack.
- Some hardening (auth edge cases, deep restart recovery, full integration coverage) is still ahead.

If you are evaluating the repository today, the safest reading is:

> The runtime direction is set, the core packages are real, and the public API surface now covers accounts, sends, invoices, and webhooks.

## Current Runtime Surface

The runtime exposes the following HTTP surface:

**Static & Dashboard**
- `GET /` — wayfinder page
- `GET /dashboard` — SSR operator dashboard (with `?view=` and `?showInternal=` toggles)

**System**
- `GET /api/health`

**Accounts**
- `POST /api/accounts` — create managed or watched account
- `GET /api/accounts` — list accounts (optional `?type=managed|watched`)
- `GET /api/accounts/:id`
- `PATCH /api/accounts/:id`
- `GET /api/accounts/:id/receivable` — pending receivable blocks from the node
- `POST /api/accounts/:id/sends` — queue a send from this account
- `GET /api/accounts/:id/sends` — list sends for this account

**Sends**
- `GET /api/sends/:id` — global send lookup

**Blocks** (escape hatch for pre-signed flows)
- `POST /api/blocks` — publish a pre-signed block JSON string

**Work** (escape hatch for non-custodial flows)
- `POST /api/work` — generate PoW for a hash

**Invoices**
- `POST /api/invoices`
- `GET /api/invoices` (optional `?status=`)
- `GET /api/invoices/:id`
- `POST /api/invoices/:id/cancel`
- `GET /api/invoices/:id/payments`
- `GET /api/invoices/:id/events` (optional `?after=`)

**Webhooks**
- `POST /api/webhooks`
- `GET /api/webhooks`
- `DELETE /api/webhooks/:id`

> All mutating operations require an `Idempotency-Key` header where documented. Sends **require** an idempotency key — rejection is correct behavior if missing.

## Design Constraints

These are deliberate constraints, not marketing copy:

- self-hostable first
- idempotency on mutating operations
- persist-first events
- one runtime for invoice and wallet domains
- multi-node RPC instead of single-node dependence
- namespace separation for invoice and managed-account derivation
- framework-agnostic runtime API built on web `Request`/`Response`
- Nano protocol primitives delegated to `@openrai/nano-core`

## Developer Experience Philosophy

RaiFlow is designed so that Nano protocol mechanics are invisible to the developer:

- **PoW is not your problem.** RaiFlow generates work internally. You never call `work_generate` in normal usage.
- **Signing is not your problem.** In custodial mode, RaiFlow signs blocks using the managed seed. Your app sends high-level intents like "send 1 XNO to this address."
- **Frontiers are not your problem.** RaiFlow tracks account frontiers and constructs blocks correctly.
- **Confirmations are not your problem.** RaiFlow watches for confirmations via WebSocket and updates send status automatically.

If you find yourself reaching for `WorkResource` or `BlocksResource` in the SDK, it indicates one of these use cases:

1. You are building a non-custodial flow where blocks are signed client-side (e.g., a browser wallet or thin client-side wallet). This is a first-class, supported integration path.
2. You are building an app-specific protocol layer that needs one-off PoW without external work provider configuration.

For custodial flows, use `SendsResource` — RaiFlow handles signing and PoW automatically.

## Repository Layout

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

## Repository Truth Sources

If you want the current state rather than the intended end state, read these first:

- `docs/progress.md` — current implementation frontier
- `ROADMAP.md` — milestone map
- `rfcs/0001-project-framing.md` — project framing and scope
- `rfcs/0003-event-model.md` — current v2 resource/event model

## Release Flow

RaiFlow uses a solo-developer Changesets flow for the public packages in this workspace:

- `@openrai/model`
- `@openrai/webhook`
- `@openrai/raiflow-sdk`

Those three published packages release in lockstep and share the same version on each repo release. `@openrai/nano-core` remains separate in its own repository and release line.

Local package development stays on `workspace:*` links, including the examples, so in-repo changes are exercised without publishing prereleases.

Typical release steps:

1. Add a changeset:

```bash
pnpm changeset
```

2. Apply the version bumps, create a release commit, and create one tag per bumped package:

```bash
pnpm release:version
```

3. Push the commit and tags:

```bash
git push && git push --tags
```

GitHub Actions then builds, tests, and publishes tagged packages from `.github/workflows/release.yml` using npm Trusted Publisher.
