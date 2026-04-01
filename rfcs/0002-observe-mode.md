# RFC 0002 — Observe Mode Architecture

**Status:** Accepted
**Created:** 2024  
**Authors:** OpenRai contributors

---

## Summary

This RFC describes the architecture for RaiFlow's first operating mode: **observe mode**.

In observe mode, RaiFlow watches one or more Nano accounts for incoming payments, matches them to known invoices, and emits normalized events — without holding or spending funds.

---

## Motivation

Observe mode is the smallest useful version of a Nano payment runtime.

A developer with a Nano address already has everything they need to receive payments. What they lack is a runtime that can:

1. watch for incoming transfers to that address
2. match transfers to known payment expectations
3. confirm that the payment has settled
4. produce a normalized proof object
5. deliver a reliable event or webhook

This is a tractable, well-bounded problem. Observe mode solves it without requiring RaiFlow to manage private keys, operate hot wallets, or handle payout logic.

---

## Design

### Components

```
┌─────────────────────────────────────┐
│              Runtime                │
│                                     │
│  InvoiceStore  ───►  Matcher        │
│                          │          │
│                          ▼          │
│                    EventEmitter     │
│                          │          │
│                          ▼          │
│                    WebhookDelivery  │
└─────────────────────────────────────┘
         ▲
         │ PaymentObservation
         │
┌─────────────────────────────────────┐
│             Watcher                 │
│                                     │
│  AccountWatcher ──► ConfirmationQ   │
│       │                             │
│  Nano node RPC                      │
└─────────────────────────────────────┘
```

### Watcher (`@openrai/watcher`)

The watcher is responsible for:

- connecting to a Nano node (WebSocket or HTTP polling)
- subscribing to account activity for configured addresses
- detecting incoming receive blocks
- tracking confirmation status
- emitting `PaymentObservation` objects to the runtime

The watcher does not know about invoices, business logic, or webhooks.

### Runtime (`@openrai/runtime`)

The runtime is responsible for:

- storing invoices and their expected payment parameters
- receiving `PaymentObservation` events from the watcher
- matching observations to open invoices (by address, amount, and status)
- producing `Payment` records for matched, confirmed payments
- emitting normalized events via typed `EventEnvelope` objects
- delivering events to registered `WebhookEndpoint` targets

### Matching logic

An observation matches an invoice when:
- the receiving address matches the invoice address
- the received amount meets or exceeds the expected amount
- the invoice is in `open` status
- the send block is confirmed

On a match:
- a `Payment` record is created
- the invoice's `confirmedAmountRaw` is updated
- a `payment.confirmed` event is emitted
- if the invoice's completion rule is now satisfied, the invoice transitions to `completed` and an `invoice.completed` event is emitted

### Confirmation threshold

The initial observe mode uses the Nano node's native confirmation signaling (confirmation subscription via WebSocket) as the default confirmation signal.

A confirmed send block is the first event that matters to application logic. Additional confirmation threshold parameters may be supported for future use.

### Invoice expiry

If a configured `expiresAt` timestamp is reached on an open invoice that has not been completed, the runtime emits an `invoice.expired` event and transitions the invoice to `expired` status.

---

## Alternatives considered

### Poll-based watching instead of WebSocket subscription
Polling is a valid fallback. The initial implementation will prefer WebSocket subscriptions where available, with a polling adapter as a fallback.

### Watch all incoming blocks globally instead of per-account
Rejected as the default. Per-account watching is simpler, more efficient, and sufficient for most use cases. Global block streaming can be considered later.

### Combine watcher and runtime into one package
Possible, but separation of concerns is cleaner. The watcher is infrastructure; the runtime is application logic. Keeping them separate allows each to be tested and replaced independently.

---

## Open questions

- What Nano node RPC client library should the watcher use?
- Should the watcher support multiple simultaneous node connections for redundancy?
- What is the minimum viable persistence model for the invoice store?
