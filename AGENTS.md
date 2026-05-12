# AI Coding Agent Instructions

---

## Bootstrap

On session start, read in order:
1. **`docs/progress.md`** — active milestone, next steps, settled decisions
2. **`README.md`** — project overview
3. **`ROADMAP.md`** — long-horizon milestones
4. **`rfcs/`** — architecture decisions relevant to your work

---

## Package Map

```
packages/
  model/       — canonical types, schemas (contract layer — DO NOT add app logic)
  config/      — YAML loader, env resolution, typed config
  storage/     — store contracts, SQLite driver, migrations
  rpc/         — multi-node RPC, WebSocket, failover, confirmation tracking
  events/      — event bus, persistence, querying
  custody/     — seed, derivation, signing, PoW, frontier ops
  runtime/     — HTTP API, services, orchestration
  webhook/     — HMAC signing, delivery engine
  raiflow-sdk/ — typed JS/TS client
  config/ custody/ events/ rpc/ storage/ watcher/ — private (not published to npm)
  model/ webhook/ raiflow-sdk/ — public (published via Trusted Publishers)

apps/
  site/        — Vitepress documentation

examples/
  express-api/ htmx-wallet/ next-checkout/ raiflow-cli/ webhook-consumer/
```

**Module system:** ESM (`"type": "module"`). All packages use `.js` extensions in imports.

**nano-core boundary:** `@openrai/nano-core` provides `NanoAmount`, `NanoAddress`, `NanoClient`, `WorkProvider`. Do not duplicate Nano protocol logic in RaiFlow packages.

---

## Key Conventions

- **Type-first:** Canonical types live in `@openrai/model`. Other packages import from model. Never duplicate types.
- **Idempotency everywhere:** Every mutating operation accepts an idempotency key. Sends **require** an idempotency key — rejection is correct behavior if missing.
- **Persist-first events:** Events are written before delivery. Delivery failure does not lose the event.
- **Derivation namespaces:** Invoice addresses and managed wallet accounts use non-overlapping index ranges from the same seed.
- **Workspace deps:** Use `workspace:*` for internal packages.
- **Framework-agnostic HTTP:** Runtime uses web-standard `Request`/`Response`.
- **YAML config with `env:`** — no hardcoded values. Use `raiflow.yml` with `env:VARIABLE_NAME` references.

---

## Build, Test, Lint

```bash
pnpm build     # all packages
pnpm test      # all packages
pnpm -r lint   # all packages
pnpm site:build # docs

# Focus commands
pnpm --filter @openrai/runtime test
pnpm --filter @openrai/runtime build

pnpm changeset # add a changeset file
pnpm release:version  # bump versions, commit, tag (after merge to main)
```

**Order matters before committing:** `pnpm build` then `pnpm test`. Lint runs in CI on the main branch — not as a pre-commit step locally.

**Test helpers:** `packages/runtime/src/__tests__/helpers.ts` — `createTestInvoice`, `createAndPayInvoice(runtime, amountRaw?, recipientAccount?)`, `makeBlock`, `createTestRuntime`. `packages/rpc/src/__tests__/helpers.ts` — `setupClientWithDifficultyMocks(options?)`.

---

## Release Process

Releases are local — CI does not publish packages.

```bash
# After changes merged to main:
pnpm release:version  # runs changeset version, commits, tags all public packages
git push && git push --tags

# npm Trusted Publishers detect tags automatically and publish to registry
```

The Release CI workflow only builds and tests on push to main — it does not create PRs or publish.

**CRITICAL — No legacy token auth:** This project uses npm Trusted Publishers with OIDC via GitHub Actions. The workflow has `id-token: write` and publishes directly to npm. **Never suggest, ask about, or attempt to add a GitHub secret `NPM_TOKEN`.** Token-based npm auth is not acceptable in 2026. If OIDC publish fails, fix the OIDC/Trusted Publishers configuration (registry URL, workflow path, permissions, or npm-side publisher setup) — do not fall back to long-lived tokens.

---

## When Making Changes

- Update `docs/progress.md` when completing tasks or shifting priorities. Keep only active milestone and next steps.
- If a change affects architecture, check whether an RFC needs updating.
- Run `pnpm build` and `pnpm test` before considering work complete.
- The `@openrai/model` package is the contract layer — changes affect all packages.

---

## Commit Policy

Commit only when:
- `pnpm build` passes
- `pnpm test` passes
- The change is coherent and the commit message reflects the purpose

Do not commit broken work or with failing tests.

---

## Progress Document Policy

`docs/progress.md` tracks **what's next and what's in progress** — not what's done. Git log records history. Keep the document lean. Remove items when completed. Remove milestone sections when fully done.