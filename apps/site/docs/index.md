---
layout: doc
title: RaiFlow
---

# RaiFlow

An open-source initiative to make Nano application integration reliable, predictable, and small.

RaiFlow is built by developers who got tired of stitching together raw node RPC calls, confirmation tracking, block interpretation, and ad-hoc webhook scripts every time they wanted to accept Nano in an application. The project produces a [payment runtime](/runtime/) — a thin layer that turns block-lattice mechanics into a stable event model for application developers.

This site is the project's home. Below are dated notes tracking the initiative's progress, decisions, and direction.

---

## Notes

### 2026-03-23 — Canonical event model simplified

We rewrote the canonical event model to be much smaller and more Nano-native. The key principle: for the mainline payment-proof story, a **confirmed matching send block** is the first event that should matter to application logic.

The model is now five events:

- `invoice.created`
- `payment.confirmed`
- `invoice.completed`
- `invoice.expired`
- `invoice.canceled`

Invoice statuses are `open`, `completed`, `expired`, `canceled`. Payment status is just `confirmed`. We dropped `payment.detected`, `webhook.delivery_failed`, and intermediate states like `pending` and `payment_detected` from the canonical surface.

The full rationale is in [RFC 0003](/rfcs/0003-event-model).

---

### 2026-03-23 — Monorepo scaffolded

The RaiFlow monorepo is now structured:

```
packages/model     — canonical types and schemas
packages/watcher   — chain observation and confirmation tracking
packages/runtime   — payment expectation + event runtime
packages/sdk-js    — JS/TS SDK
packages/webhook   — webhook signing and delivery helpers
examples/          — reference integrations
rfcs/              — design records
```

All packages build. Implementation starts with `@openrai/model` (frozen) and `@openrai/watcher` (next).

---

### 2026-03-23 — Project framing published

Three RFCs define the initial shape:

- [RFC 0001 — Project framing](/rfcs/0001-project-framing): what RaiFlow is, what it is not, and what it builds first
- [RFC 0002 — Observe mode](/rfcs/0002-observe-mode): the first operating mode — keyless payment observation
- [RFC 0003 — Event model](/rfcs/0003-event-model): canonical events, resource shapes, delivery semantics

The core doctrine: **observe first, events first, tiny API first, custody later.**

---

### 2026-03-23 — Why this exists

Nano has strong settlement properties — feeless, fast finality, permissionless. But developers who want to accept Nano in real applications face a significant integration gap. You end up writing:

- node RPC polling
- confirmation tracking
- block/account interpretation
- payment matching
- metadata joins
- webhook delivery
- retry and idempotency logic

That is too much raw infrastructure for every app to reinvent. RaiFlow exists to absorb that complexity into a small, reliable runtime so application developers can focus on their product.
