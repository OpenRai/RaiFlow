# RFC 0003 — Event Model and Delivery Semantics

**Status:** Draft  
**Created:** 2024  
**Authors:** OpenRai contributors

---

## Summary

This RFC defines the canonical event model for RaiFlow: the event types, their payload shapes, resource definitions, and delivery semantics for webhooks.

The model is intentionally small and Nano-native. For the mainline payment-proof story, a confirmed matching send block is the first event that should matter to application logic.

---

## Motivation

Applications integrating with RaiFlow need a reliable, predictable event contract. Without a frozen event model, every implementation detail becomes a coordination problem.

This RFC fixes:
- the invoice and payment resource shapes
- the event type vocabulary
- the typed event envelope and payload shapes
- the delivery guarantees RaiFlow targets
- the webhook signing and verification contract

---

## Core doctrine

- **Invoices** are business expectations.
- **Payments** are confirmed matching Nano transfers.
- **Invoice completion** is a business rule derived from collected confirmed payments.

We do not canonize intermediate stages (detected, observed, receivable, settled) in the first model. Those are better treated as derived summaries, UI hints, or optional SDK conveniences.

For most developers, the meaningful progression is:

1. invoice created
2. payment confirmed
3. invoice completed

---

## Design

### Invoice lifecycle

```typescript
type InvoiceStatus =
  | 'open'
  | 'completed'
  | 'expired'
  | 'canceled';
```

- **`open`** — The invoice is active and can still be satisfied by incoming confirmed payments.
- **`completed`** — The invoice's collection rule has been satisfied by confirmed payment(s).
- **`expired`** — The invoice is no longer collectible under normal policy because its validity window ended before completion.
- **`canceled`** — The invoice was intentionally closed before completion.

Statuses like `payment_detected`, `partially_paid`, or `awaiting_confirmation` are intentionally not first-class invoice statuses. They may exist as derived fields or SDK conveniences, but the invoice lifecycle itself remains: open → completed | expired | canceled.

### Payment model

```typescript
type PaymentStatus =
  | 'confirmed';
```

A payment record represents a **confirmed matching payment fact** — not every possible provisional observation.

- **`confirmed`** — RaiFlow has verified that a confirmed Nano send block matching the invoice expectation exists.

We may later introduce operational states (`observed`, `candidate`, `rejected`, `late`, `unmatched`) as advanced extensions, but they are not required for the mainline payment-proof story.

### Invoice shape

```typescript
interface Invoice {
  id: string;
  status: InvoiceStatus;

  currency: 'XNO';
  expectedAmountRaw: string;
  confirmedAmountRaw: string;

  createdAt: string;
  expiresAt?: string;
  completedAt?: string;
  expiredAt?: string;
  canceledAt?: string;

  metadata?: Record<string, unknown>;
}
```

- `expectedAmountRaw` = target amount
- `confirmedAmountRaw` = total of confirmed matching payments
- `metadata` = app context, always off-chain

### Payment shape

```typescript
interface Payment {
  id: string;
  invoiceId: string;

  status: PaymentStatus;

  currency: 'XNO';
  amountRaw: string;

  recipientAccount: string;
  senderAccount?: string;

  sendBlockHash: string;
  confirmedAt: string;

  metadata?: Record<string, unknown>;
}
```

The key payment identity comes from the confirmed send block. This resource answers the developer's real question: "What confirmed payment did RaiFlow match to my invoice?"

### Event types

```typescript
type RaiFlowEventType =
  | 'invoice.created'
  | 'payment.confirmed'
  | 'invoice.completed'
  | 'invoice.expired'
  | 'invoice.canceled';
```

### Event envelope

Every event shares a typed envelope:

```typescript
interface EventEnvelope<TType extends RaiFlowEventType, TData> {
  id: string;        // unique event ID (UUIDv4)
  type: TType;       // event type string
  createdAt: string;  // ISO 8601 timestamp
  data: TData;       // typed event-specific payload
}
```

### Event payloads

#### `invoice.created`

Emitted when a new payment expectation is created.

```typescript
type InvoiceCreatedEvent = EventEnvelope<
  'invoice.created',
  { invoice: Invoice }
>;
```

#### `payment.confirmed`

Emitted when RaiFlow verifies a confirmed Nano send block matching the expectation. This is the key event for the mainline payment-proof story.

It means:
- value has been sent to the intended destination address
- the send block is confirmed
- the payment can be treated as a valid payment proof

It does **not** necessarily mean:
- the invoice is fully satisfied
- the payment arrived before expiry policy

```typescript
type PaymentConfirmedEvent = EventEnvelope<
  'payment.confirmed',
  { payment: Payment; invoice: Invoice }
>;
```

Both payment and invoice are included because most app logic wants the confirmed payment fact alongside the current invoice state after applying it.

#### `invoice.completed`

Emitted when the invoice's completion rule has been satisfied by one or more confirmed payments.

```typescript
type InvoiceCompletedEvent = EventEnvelope<
  'invoice.completed',
  { invoice: Invoice }
>;
```

#### `invoice.expired`

Emitted when the invoice ceased being collectible under policy before it was completed.

An expired invoice may still have received some payment before or after expiry — expiry is about the invoice business rule, not about whether a payment block exists on-chain.

```typescript
type InvoiceExpiredEvent = EventEnvelope<
  'invoice.expired',
  { invoice: Invoice }
>;
```

#### `invoice.canceled`

Emitted when the invoice was intentionally closed before completion. This is business-driven, not chain-driven.

```typescript
type InvoiceCanceledEvent = EventEnvelope<
  'invoice.canceled',
  { invoice: Invoice }
>;
```

---

## Invariants

These are more important than having lots of states.

### 1. Completion is terminal
If `invoice.status === 'completed'`, it should not later become `open`.

### 2. Expiry and cancellation are terminal
If `expired` or `canceled`, it should not later become `open`.

### 3. Confirmed amount is monotonic
`confirmedAmountRaw` should never decrease in observe mode.

### 4. Completion depends on confirmed payment, not provisional observation
An invoice becomes `completed` only from confirmed payment facts.

### 5. Payment confirmation is idempotent
The same confirmed send block must not produce duplicate business effects.

---

## What is intentionally not canonized yet

We may eventually need more operational or diagnostic distinctions, but they remain non-canonical until proven necessary:

- `payment.detected` / `payment.observed` / `payment.receivable` / `payment.settled`
- `invoice.payment_detected` / `invoice.partially_paid` / `invoice.awaiting_confirmation`
- `webhook.delivery_failed`

Introducing them too early risks:
1. making Nano feel more complex than it needs to
2. encouraging developers to branch logic on distinctions they do not need
3. confusing payment settlement with invoice completion
4. recreating semantics borrowed from other systems instead of staying Nano-native

If needed later, they should be framed as **advanced extensions**:

```typescript
type AdvancedPaymentEventType =
  | 'payment.observed'
  | 'payment.unmatched'
  | 'payment.rejected';
```

With a clear note: these events are operational extensions, not required for the mainline Nano payment-proof story.

---

## Delivery semantics

RaiFlow targets **at-least-once delivery** for webhook events.

This means:
- events may be delivered more than once (due to retries)
- consumers must handle duplicate delivery idempotently
- each event has a stable `id` that can be used for deduplication

**At-exactly-once delivery is not guaranteed.** Applications should use the event `id` as an idempotency key.

### Retry policy

The initial retry policy is:
- up to 5 delivery attempts per event
- exponential backoff between attempts (1s, 5s, 30s, 5min, 30min)
- failed deliveries are logged for observability

### Webhook signing

Each webhook delivery is signed using HMAC-SHA256 with the endpoint secret.

The signature is included in the `X-RaiFlow-Signature` HTTP header:

```
X-RaiFlow-Signature: sha256=<hex_digest>
```

The signed payload is the raw JSON body of the request.

Consumers should verify the signature before processing any event.

---

## Alternatives considered

### Use exactly-once delivery guarantees
Exactly-once delivery is difficult to guarantee across network boundaries without coordination at the consumer level. At-least-once with idempotency keys is the standard approach and is simpler to implement correctly.

### Use a different signing scheme (e.g. ECDSA, JWT)
HMAC-SHA256 is simple, widely understood, and battle-tested for webhook signing (used by Stripe, GitHub, etc). It is the right default.

### Embed full objects vs. references in event payloads
Events embed the full relevant objects (e.g. `Invoice`, `Payment`) rather than just IDs. This makes events self-contained and reduces the need for consumers to make additional API calls to process an event.

### Canonize intermediate payment states
Rejected for the first model. States like `detected`, `observed`, or `receivable` are internal or operational concerns. They risk bloating the public API with distinctions that Nano's mainline payment-proof flow does not require.

---

## Open questions

- Should events be persisted in a queryable event log, or only delivered via webhooks?
- Should consumers be able to replay missed events?
- What clock source should be used for `createdAt` timestamps?
- What invoice completion policies should be supported (exact match, minimum, overpay-accepted)?
