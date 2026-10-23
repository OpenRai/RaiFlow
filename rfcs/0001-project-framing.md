# RFC 0001 — Project Framing

This RFC establishes the foundational framing for RaiFlow v2: what it is, what it is not, and the scope fence that separates RaiFlow from the application layer.

---

## Summary

RaiFlow is a self-hostable Nano payment runtime. It runs on your infrastructure, connects to one or more Nano nodes, and exposes a clean, idempotent, event-driven API for two directions of value movement: getting paid and operating a wallet.

## Commerce Scope Decision — 2026-10-20

The primary integrations are external-wallet checkout, reusable customer deposit
accounts, and custodial withdrawals. Applications issue payment intents and
consume durable business events. RaiFlow owns receiving, signing, work,
frontiers, confirmation recovery, and settlement housekeeping.

Nanosweeper's tile-account matrices and client-wallet transaction controls are
outside this scope. The following APIs are obsolete and removed:

- `POST /v1/subaccounts/allocate` and SDK `subaccounts.allocate()`.
- `POST /v1/receives/batch` and SDK `receives.batch()`.
- Deferred watcher activation and allocation-stage diagnostics for tile matrices.

Applications create managed or watched accounts through the account resource;
one-time payment expectations use invoices. Receiving is internal housekeeping.
Generic watched accounts, business event subscriptions, and the established
pre-signed-block flow retain their own uses. New integration needs must justify
their place in the commerce programming model.

There are no known commercial consumers. Backwards compatibility does not
constrain API or internal refactoring; obsolete paths receive no aliases.
The repair work is tracked in Beads under epic `RaiFlow-7w6`.

## Implemented commerce contract — 2026-10-22

The runtime and SDK expose the commerce API under `/v1`. Confirmed inbound
transfers are represented as deposits and, when matched, invoice payments.
Applications can list account deposits and request a refund by linking an
explicit destination and amount to a confirmed deposit. The application owns
customer identity and destination verification; RaiFlow never assumes that a
Nano sender address is a refund destination. Receiving minimums are configurable
and applied before persistence. A 1 GiB global database limit and a 100,000
deposit per-destination limit bound inbound persistence by default. RaiFlow
retains existing evidence and pauses new ingestion at either limit; it does not
expire old deposit or event history.

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

An explicit `invoiceKey` is an application reference and reuses its persisted invoice destination for that account. When it is omitted, each invoice gets a distinct destination; absence is not a reusable key. Invoice derivation indices are allocated monotonically from the configured invoice namespace and persisted with their destination. Reusable customer deposits are a separate managed-account use case.

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
- `Deposit` — a confirmed inbound Nano send, stored independently of invoice matching and optionally linked to an invoice
- `Payment` — a confirmed transfer matched to an invoice
- `Account` — a managed or watched Nano account
- `Send` — an outbound send operation
- `Event` — a typed, persisted application event
- `WebhookEndpoint` — a registered delivery target

Deposit history records the Nano source block, destination, amount, sender when
available, and confirmation time. An optional invoice link records RaiFlow's
matching decision; sender identity does not establish application customer
identity, and deposit history does not make RaiFlow a customer ledger.

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
