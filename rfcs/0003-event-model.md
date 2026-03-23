# RFC 0003 — Event Model and Delivery Semantics

**Status:** Draft  
**Created:** 2024  
**Authors:** OpenRai contributors

---

## Summary

This RFC defines the event model for RaiFlow: the canonical event types, their payload shapes, and the delivery semantics for webhooks.

---

## Motivation

Applications integrating with RaiFlow need a reliable, predictable event contract. Without a frozen event model, every implementation detail becomes a coordination problem.

This RFC fixes:
- the event type vocabulary
- the payload shape for each event type
- the delivery guarantees RaiFlow targets
- the webhook signing and verification contract

---

## Design

### Event structure

Every event shares a common envelope:

```typescript
interface Event {
  id: string           // unique event ID (UUIDv4)
  type: EventType      // event type string
  invoiceId: string    // the related invoice ID
  payload: object      // event-specific payload (see below)
  createdAt: string    // ISO 8601 timestamp
}
```

### Event types

#### `invoice.created`

Emitted when a new invoice is created.

```typescript
{
  invoice: Invoice
}
```

#### `payment.detected`

Emitted when an incoming payment is observed but not yet confirmed.

```typescript
{
  invoice: Invoice
  blockHash: string
  fromAddress: string
  amountRaw: string
  detectedAt: string
}
```

#### `payment.confirmed`

Emitted when an incoming payment is confirmed and a `PaymentProof` is produced.

```typescript
{
  invoice: Invoice
  proof: PaymentProof
}
```

#### `invoice.completed`

Emitted when an invoice transitions to `completed` status.

```typescript
{
  invoice: Invoice
  proof: PaymentProof
}
```

#### `invoice.expired`

Emitted when an invoice transitions to `expired` status due to reaching its `expiresAt` without a matching payment.

```typescript
{
  invoice: Invoice
  expiredAt: string
}
```

#### `webhook.delivery_failed`

Emitted internally when a webhook delivery attempt fails after all retries are exhausted.

```typescript
{
  webhookEndpointId: string
  eventId: string
  eventType: EventType
  lastAttemptAt: string
  lastStatusCode: number | null
  attemptCount: number
}
```

---

### Delivery semantics

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
- after all retries exhausted, a `webhook.delivery_failed` event is emitted

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
Events embed the full relevant objects (e.g. `Invoice`, `PaymentProof`) rather than just IDs. This makes events self-contained and reduces the need for consumers to make additional API calls to process an event.

---

## Open questions

- Should events be persisted in a queryable event log, or only delivered via webhooks?
- Should consumers be able to replay missed events?
- What clock source should be used for `createdAt` timestamps?
