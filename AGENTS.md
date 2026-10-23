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
pnpm release:version  # manual release escape hatch; main publishes automatically
```

**Order matters before committing:** `pnpm build` then `pnpm test`. Lint runs in CI on the main branch — not as a pre-commit step locally.

**Test helpers:** `packages/runtime/src/__tests__/helpers.ts` — `createTestInvoice`, `createAndPayInvoice(runtime, amountRaw?, recipientAccount?)`, `makeBlock`, `createTestRuntime`. `packages/rpc/src/__tests__/helpers.ts` — `setupClientWithDifficultyMocks(options?)`.

---

## Release Process

The Release workflow uses Changesets and npm Trusted Publishing (OIDC). On push to main:

- Build and tests pass → Changesets versions the packages
- Packages publish through OIDC → the version commit and `@openrai/*@X.Y.Z` tags are pushed directly to main

### Developer flow

```bash
pnpm changeset  # add a changeset file
git add . && git commit -m "chore: add changeset" && git push
```

1. Add a changeset with the feature or fix
2. Push the change to main
3. CI builds, tests, versions, and publishes eligible packages directly (OIDC, no tokens)

### Manual escape hatch

```bash
# If the automated flow is unavailable, version and tag locally, then push:
pnpm release:version
git push origin HEAD:main --atomic --tags
```

The `scripts/release-version.mjs` script is retained as the manual escape hatch. The primary flow versions and publishes directly from the main-branch workflow.

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

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
