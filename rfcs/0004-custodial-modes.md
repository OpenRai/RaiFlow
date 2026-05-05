# RFC 0004: Custodial Modes and SDK Philosophy

**Status:** Accepted
**Date:** 2026-05-05

## Context

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
