# RFC 0004: Custodial Modes and SDK Philosophy

**Status:** Accepted
**Date:** 2026-05-05

## Context

### Current implementation note — 2026-10-22

This RFC's mode and API key decisions remain current. Custody is provided by the
configured OWS wallet provider; RaiFlow does not require or load a raw seed in
the current custodial integration. Receiving, account-chain serialization, and
recovery are runtime responsibilities. Deposit refunds use an explicit
application-verified destination and the normal durable send pipeline. For
current routes and available operations, see the root README and SDK reference.

RaiFlow sits between an application and Nano nodes. The application may want different levels of control over the Nano protocol:

1. **Full delegation** — the app never touches keys, blocks, PoW, or frontiers. RaiFlow handles everything.
2. **Client-side signing** — the app (or a browser wallet) signs blocks and sends them to RaiFlow for publishing and monitoring.

These two postures are fundamentally different in what RaiFlow needs to know and what operations it can perform. A single "mode" field at startup cleanly separates them and prevents runtime errors from attempting operations that require missing material (like a seed).

## Decision

### Startup Mode

RaiFlow requires a `RAIFLOW_MODE` environment variable (or `daemon.mode` in `raiflow.yml`) at startup. The value is one of:

- `custodial` — RaiFlow manages keys, derives accounts, signs blocks, generates PoW.
- `non-custodial` — RaiFlow acts as a relay and monitor. All signing happens client-side.

If the mode is not set, RaiFlow refuses to start with a clear error message explaining both options.

### Account-chain write coordination — 2026-10-22

RaiFlow serializes custodial writes per Nano account address through one
internal executor. Sends and receives use it now; representative-field updates
also acquire it, and future on-chain representative changes and treasury
settlement must use the same executor. SQLite stores expiring leases and
monotonically increasing fencing tokens. The executor renews its lease while
active and checks that its token is still current before each publish or
operation-state write. A worker that loses its lease must stop; after
expiration, another worker can recover the account. Lease ownership and fencing
tokens remain internal and are not part of the public SDK or HTTP API.

Before publishing a send, RaiFlow persists its exact signed block, work value,
expected hash and resulting balance in private storage. Restarts reuse this
intent rather than signing against a newer frontier. A timeout or failure after
the publish call begins remains recoverable and does not mark the transfer
failed; RaiFlow queries or rebroadcasts the saved block to resolve the outcome.

Receives use the same account lease and persist their exact signed block intent
before publishing. Confirmed inbound sends trigger receivable discovery during
ingest, even when invoice matching completes the invoice. Source-send
confirmation and RaiFlow's own receive-block confirmation are tracked as
separate events and states.

### Mode-Gated Features

| Feature | Custodial | Non-custodial |
|---------|-----------|---------------|
| Watched accounts | ✓ | ✓ |
| Managed accounts | ✓ | ✗ (501) |
| Sends (POST /accounts/:id/sends) | ✓ | ✗ (501) |
| Invoices | ✓ | ✗ (501) |
| Block publishing (POST /blocks) | ✓ | ✓ |
| Work generation (POST /work) | ✓ | ✓ |
| All GET endpoints | ✓ | ✓ |

### Custodial Mode Validation

In custodial mode, RaiFlow validates that `custody.seed` and `custody.representative` are configured. If either is missing, RaiFlow refuses to start.

### API Key

`RAIFLOW_API_KEY` is required. No auto-generation, no hidden files. The developer picks their own key. Resolution order:

1. `RAIFLOW_API_KEY` environment variable
2. `daemon.apiKey` in `raiflow.yml` (supports `env:` references)
3. Fail with clear error

### SDK Philosophy

The `@openrai/raiflow-sdk` is designed so that Nano protocol mechanics are invisible to the developer:

- **`SendsResource`** is the primary interface for moving funds. RaiFlow handles signing, PoW, and frontier management internally.
- **`WorkResource`** is a low-level escape hatch. Its JSDoc warns that direct usage indicates a missing SDK feature.
- **`BlocksResource`** exists for non-custodial pre-signed flows. Its JSDoc clarifies that custodial flows should use `SendsResource`.

The `apiKey` field in `RaiFlowClientOptions` is required (not optional).

## Consequences

- Existing Docker deployments that relied on auto-generated API keys will need to set `RAIFLOW_API_KEY` explicitly.
- Existing deployments that did not set `RAIFLOW_MODE` will need to add it.
- The README, Docker Compose example, and config examples are updated to reflect the new required variables.
- The `show-api-key` CLI utility is removed (no longer needed).
