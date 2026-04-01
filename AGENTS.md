# AGENTS

Instructions for AI coding agents working on the RaiFlow project.

---

## Context Bootstrap

On session start, read these files to understand the project:

1. **`docs/progress.md`** — Current phase status, architecture overview, dependency graph, action items. This is where we track progress and plan next steps. Update it as phases complete or priorities shift. The plan is not set in stone — it evolves as the project progresses.
2. **`README.md`** — Project doctrine and high-level overview.
3. **`ROADMAP.md`** — Original roadmap (Phases 0–6). Cross-reference with `docs/progress.md` for current status.
4. **`rfcs/`** — Design decisions. RFCs 0001–0003 are Accepted. Draft RFCs 0004–0006 are planned.

## Project Structure

```
packages/
  model/       — Canonical types (Invoice, Payment, EventEnvelope, store interfaces)
  watcher/     — Chain observation (WebSocket + RPC polling)
  runtime/     — Invoice lifecycle, payment matching, HTTP API
  webhook/     — HMAC-SHA256 signing, delivery with retry
  raiflow-sdk/ — Business client SDK (HTTP wrapper for runtime API)
apps/
  site/        — Documentation site (VitePress)
examples/
  express-api/       — Reference Express integration (planned)
  next-checkout/     — Reference Next.js demo (planned)
  webhook-consumer/  — Reference webhook handler (planned)
  htmx-wallet/       — HTMX wallet demo
rfcs/          — Design RFCs
docs/          — Architecture review, progress tracking
```

## Key Conventions

- **Workspace:** pnpm monorepo. Use `workspace:*` for internal deps. Use `pnpm -r build/test/lint`.
- **Module system:** ESM (`"type": "module"`). All packages use `.js` extensions in imports.
- **Framework-agnostic HTTP:** Runtime uses web-standard `Request`/`Response`. Works on Node, Deno, Bun, Workers.
- **Type-first:** Canonical types live in `@openrai/model`. Other packages import from model, never duplicate types.
- **Idempotency:** Payment systems are retry-heavy. Treat idempotency as default, not afterthought.
- **nano-core is external:** Published to npm as `@openrai/nano-core`. Not in this monorepo. raiflow-sdk depends on `^1.0.0`.

## When Making Changes

- Update `docs/progress.md` when completing tasks or shifting priorities.
- If a change affects the architecture, check whether an RFC needs updating or drafting.
- Run `pnpm -r build` and `pnpm -r test` before considering work complete.
- The `@openrai/model` package is the contract layer. Changes here affect all packages.

## Progress Document Policy

`docs/progress.md` tracks **what's next and what's in progress** — not what's done. Git log already records history; duplicating it here adds noise. When a task is completed, remove it from the checklist. When a phase is fully done, remove the phase section entirely. Keep the document lean and forward-looking.
