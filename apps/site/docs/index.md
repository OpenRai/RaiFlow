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

### 2026-03-23 — Observe-mode runtime ships

The runtime is real. Four packages, 103 tests, one process.

RaiFlow now has a working observe-mode payment runtime that you can point at a Nano node and start accepting payments through. No private keys required. The runtime watches accounts you control, matches incoming confirmed sends to open invoices, and emits typed events to your application via webhooks.

#### What shipped

**`@openrai/watcher`** — Chain observation. Connects to a Nano node via WebSocket (real-time confirmations) or RPC polling (fallback). Subscribes per-account, reconnects with backoff, and feeds typed `ConfirmedBlock` observations to the runtime. No block-lattice knowledge leaks into the rest of the system.

**`@openrai/runtime`** — The core. Manages the invoice lifecycle (`open` → `completed` | `expired` | `canceled`), matches confirmed blocks to open invoices using FIFO ordering, accumulates partial payments with BigInt arithmetic, and emits events. Exposes a REST API over web standard `Request`/`Response` — works with Node, Bun, Deno, or anything that speaks HTTP.

**`@openrai/webhook`** — Delivery infrastructure. HMAC-SHA256 signing (Stripe-style `t=<timestamp>,v1=<hmac>` format), signature verification for consumers, at-least-once delivery with exponential backoff and jitter, endpoint registration.

**HTTP API** — Ten endpoints, no framework dependency:

```
POST   /invoices              Create (Idempotency-Key header)
GET    /invoices              List (?status=open)
GET    /invoices/:id          Get
POST   /invoices/:id/cancel   Cancel
GET    /invoices/:id/payments List payments
GET    /invoices/:id/events   List events
POST   /webhooks              Register endpoint
GET    /webhooks              List endpoints
DELETE /webhooks/:id          Remove endpoint
GET    /health                Liveness check
```

#### Design choices that matter

**Idempotency is structural, not optional.** Invoice creation accepts an `Idempotency-Key` header. Block processing deduplicates by send block hash. These aren't features — they're invariants. A developer who retries a request or a watcher that replays a block cannot produce duplicate state. This is what separates payment infrastructure from a demo.

**The runtime does not depend on the watcher.** They share a contract type (`ConfirmedBlock` and `WatcherSink` in `@openrai/model`) and are wired together at the application level. Today they run in one process. Tomorrow the watcher could push observations over a queue, and the runtime wouldn't change. The seam is there.

**No framework lock-in.** The HTTP handler is a pure `(Request) => Promise<Response>` function. Mount it in Express, Fastify, Hono, Bun.serve, Deno.serve, or a raw Node `http.createServer`. The entry point (`main.ts`) includes a Node adapter, but the handler itself is portable.

**Observe mode means no keys, no custody, no receive blocks.** The runtime watches for confirmed *send* blocks to your accounts. It never holds seeds, never signs blocks, never moves funds. This is the right first mode for most integrations — you don't need custody to accept payments.

**Web standard `Request`/`Response` over framework abstractions.** The runtime doesn't import Express, Hono, or any router. Ten routes don't need a routing library. The handler is ~220 lines of URL parsing and JSON serialization. This is a deliberate choice: dependencies you don't add can't break.

#### What this means

You can now:

1. Start the runtime pointed at your Nano node
2. `POST /invoices` with a recipient address, expected amount, and optional metadata
3. When someone sends Nano to that address, receive a `payment.confirmed` webhook
4. When the invoice threshold is met, receive an `invoice.completed` webhook
5. If the invoice expires, receive an `invoice.expired` webhook

Your application never touches RPC. It never interprets blocks. It gets clean, typed JSON events and acts on them.

#### Who should look at this

If you're building Nano payment infrastructure — CLI tools, wallet backends, merchant integrations, payment gateways — the model and event vocabulary here are designed to be adopted or forked. The `Invoice` / `Payment` / `EventEnvelope` types are intentionally minimal and Nano-native. They might be useful even if you don't use the runtime.

If you're experimenting with HTTP payment negotiation for agents or machines — protocols where a service responds with payment-required and a client settles programmatically — RaiFlow's headless, API-first approach is built for exactly that flow. No QR codes, no browser, no wallet UI. `POST /invoices`, get an address, pay, receive confirmation via webhook. That's the loop.

If you think the Nano ecosystem needs a credible answer to the "nanopayments for AI agents and machine commerce" narrative that stablecoin infrastructure is currently claiming, this is an attempt at that answer. Nano's settlement characteristics — truly feeless, sub-second, no gas, no batching, no intermediary — are most differentiable in server-to-server and agent-to-service flows. Not in QR-code retail. Not in generic merchant handwaving.

The runtime is in-memory only right now. Persistent stores, the typed SDK, and reference integrations are next. But the model is stable, the API is real, and the test suite covers the critical paths: matching, idempotency, state machines, signing.

Source is on [GitHub](https://github.com/openrai/raiflow). The [roadmap](/roadmap) is a living checklist.

---

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
