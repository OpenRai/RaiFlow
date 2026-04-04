# AI Coding Agent Instructions

Instructions for AI coding agents working on the RaiFlow project.

---

## Context Bootstrap

On session start, read these files to you understand the project:

1. **`docs/progress.md`** — Current implementation frontier, active milestone, dependency graph, and settled architecture decisions. Start here every time.
2. **`README.md`** — Project doctrine and high-level overview.
3. **`ROADMAP.md`** — Long-horizon milestone map. Reference for what's next.
4. **`rfcs/`** — Architecture decisions. Read the relevant RFC before making design choices in that area.

## Package Map

```
packages/
  model/       — canonical types, schemas, shared contracts (DO NOT add app logic here)
  config/      — YAML loader, env resolution, typed config
  storage/     — store contracts, SQLite driver, migrations
  rpc/         — multi-node RPC, WebSocket, failover, confirmation tracking
  events/      — event bus, persistence, querying
  custody/     — seed, derivation, signing, PoW, frontier ops
  runtime/     — HTTP API, services, orchestration
  webhook/     — HMAC signing, delivery engine
  raiflow-sdk/ — typed JS/TS client for the runtime API
```

**Module system:** ESM (`"type": "module"`). All packages use `.js` extensions in imports.

**nano-core boundary:** `@openrai/nano-core` (separate repo, published to npm) provides `NanoAmount`, `NanoAddress`, `NanoClient`, `WorkProvider`. RaiFlow owns orchestration, storage, event routing, and application semantics. Do not duplicate Nano protocol logic in RaiFlow packages.

## Key Conventions

- **Type-first:** Canonical types live in `@openrai/model`. Other packages import from model. Never duplicate types.
- **Idempotency everywhere:** Every mutating operation accepts an idempotency key. Sends **require** an idempotency key — rejection is the correct behavior if missing.
- **Persist-first events:** Events are written before delivery is attempted. Delivery failure does not lose the event.
- **Derivation namespaces:** Invoice addresses and managed wallet accounts use non-overlapping index ranges from the same seed.
- **Workspace deps:** Use `workspace:*` for internal packages.
- **Framework-agnostic HTTP:** Runtime uses web-standard `Request`/`Response`. Works on Node, Deno, Bun, Workers.
- **YAML config with `env:`:** No hardcoded values. Use `raiflow.yml` with `env:VARIABLE_NAME` references.

## When Making Changes

- Update `docs/progress.md` when completing tasks or shifting priorities. Keep only the active milestone and next steps.
- If a change affects architecture, check whether an RFC needs updating.
- Run `pnpm -r build` and `pnpm -r test` before considering work complete.
- The `@openrai/model` package is the contract layer. Changes here affect all packages.

## Progress Document Policy

`docs/progress.md` tracks **what's next and what's in progress** — not what's done. Git log records history. Keep the document lean and forward-looking. Remove items when completed. Remove milestone sections when fully done.

## Build and Test

```bash
# Build all packages
pnpm -r build

# Run all tests
pnpm -r test

# Run tests in one package
pnpm --filter @openrai/runtime test

# Lint
pnpm -r lint
```

## Commit Policy

Commit only when:
- `pnpm -r build` passes
- `pnpm -r test` passes
- The change is coherent and the commit message accurately reflects the purpose

Do not commit broken work. Do not commit with failing tests.
