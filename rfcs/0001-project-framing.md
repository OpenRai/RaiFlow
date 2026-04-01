# RFC 0001 — Project Framing

This RFC establishes the foundational framing for RaiFlow v2: what it is, what it is not, and the scope fence that separates RaiFlow from the application layer.

---

## Summary

RaiFlow is a self-hostable Nano payment runtime. It runs on your infrastructure, connects to one or more Nano nodes, and exposes a clean, idempotent, event-driven API for two directions of value movement: getting paid and operating a wallet.

---

## Motivation

Nano has strong settlement properties: feeless transfer, fast finality, permissionless access, no mining overhead.

What developers lack is a runtime that absorbs every low-level Nano operation — block construction, signing, PoW, receivable management, frontier tracking, confirmation monitoring, representative configuration — and exposes a clean application API.

RaiFlow fills that gap.

---

## What RaiFlow Is

An application-facing payment runtime for Nano.

It talks to Nano nodes. Your application talks to RaiFlow. Your application never touches raw RPC.

RaiFlow is a **thin runtime** — it adds orchestration, state management, event routing, and reliability guarantees. It does not add business logic. Pricing, customer management, product catalogs, order management — all belong in the application layer.

---

## What RaiFlow Is Not

| RaiFlow is NOT | Why |
|---|---|
| A consumer wallet | No contact book, no transaction history UI |
| A hosted SaaS / payment gateway | You run it. It's yours. |
| An e-commerce platform | No carts, products, or customer accounts |
| A block explorer | No global chain indexing |
| A Nano node | Depends on one or more nodes via RPC/WS |
| A fiat on/off ramp | XNO only |

---

## Operational Domains

RaiFlow operates two co-equal domains simultaneously in the same instance:

**Invoice Domain** — "Get paid"

Create payment expectations, derive addresses, detect and match incoming confirmed payments, manage lifecycle (complete/expire/cancel), optionally sweep collected funds to treasury.

If invoice address selection depends on any external identifier or application string, the mapping must be deterministic and stable across restarts. Random address selection without persisted mapping is not acceptable.

**Wallet Domain** — "Operate a wallet"

Manage derived accounts from a seed, watch external accounts without holding keys, send XNO, publish pre-signed blocks, generate work on demand, track balances and frontiers, auto-receive pending blocks.

Both domains share: custody engine, RPC layer, event system, and persistent storage.

---

## Custody Modes

Three custody modes coexist in the same instance:

**Managed custody** — RaiFlow holds the seed. Derives accounts, signs blocks, generates PoW, auto-receives, executes sends. You issue commands.

**Watched accounts** — You hold the keys. RaiFlow monitors the account, delivers events, but cannot sign for it.

**Pre-signed publish** — You sign blocks in an air-gapped environment. RaiFlow publishes them through its reliable RPC layer with failover and confirmation tracking.

A single application might use managed accounts for treasury, watched accounts for monitoring customer wallets, and pre-signed publishing for an advanced air-gapped flow. All at the same time. All through the same SDK. All producing events into the same unified stream.

---

## Core Primitives

The initial public API surface:

- `Invoice` — a payment expectation
- `Payment` — a confirmed matching Nano transfer
- `Account` — a managed or watched Nano account
- `Send` — an outbound send operation
- `Event` — a typed, persisted application event
- `WebhookEndpoint` — a registered delivery target

---

## Event Vocabulary

```
Invoice Domain:
  invoice.created    — new payment expectation
  invoice.payment_received  — pending block detected
  invoice.payment_confirmed — matching block confirmed
  invoice.completed  — fully paid
  invoice.expired    — validity window ended
  invoice.canceled   — intentionally closed
  invoice.swept      — funds swept to treasury

Wallet Domain — Account:
  account.created    — managed or watched account added
  account.received   — inbound block detected
  account.balance_updated — confirmed balance changed
  account.removed    — account deleted or watch stopped

Wallet Domain — Send:
  send.queued        — send operation accepted
  send.published     — block published to network
  send.confirmed     — block confirmed
  send.failed        — rejected, timeout, or fork

Wallet Domain — Block:
  block.published    — pre-signed block published
  block.confirmed    — pre-signed block confirmed
  block.failed       — pre-signed block rejected

Infrastructure:
  rpc.connected      — WebSocket connection established
  rpc.disconnected   — WebSocket connection lost
  rpc.failover       — switched to backup node
```

---

## Idempotency

Every mutating operation accepts an idempotency key.

**Sends require an idempotency key — rejection is correct behavior if missing.** This is a non-negotiable safety rail. Sending XNO is irreversible; accidental double-sends are catastrophic.

---

## Doctrine Summary

> You run RaiFlow. It talks to Nano. Your app talks to RaiFlow.

1. Both domains, one runtime
2. Confirmed payment first
3. Events first
4. Idempotency everywhere
5. Custody modes coexist
6. Self-hostable always

---

## Out of Scope (Permanently)

- Consumer wallet UI
- Fiat conversion
- Multi-currency support
- User account system beyond API key
- Product catalog / cart / checkout UI
- Mobile or desktop GUI
- Consensus participation
- Global chain indexing

---

## Out of Scope (For Now)

- PostgreSQL driver (SQLite first)
- Clustering / HA
- Rate limiting
- Prometheus metrics
- gRPC API
- Plugin system
- Hardware security module integration
- Scheduled / recurring payments
