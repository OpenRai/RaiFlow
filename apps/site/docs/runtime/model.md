# Event Model

The canonical RaiFlow event model. Intentionally small and Nano-native.

For the mainline payment-proof story, a confirmed matching send block is the first business-significant payment event. We avoid canonizing intermediate states unless proven necessary.

## Invoice

```typescript
type InvoiceStatus =
  | 'open'
  | 'completed'
  | 'expired'
  | 'canceled';

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

| Field | Meaning |
|-------|---------|
| `expectedAmountRaw` | Target amount in raw |
| `confirmedAmountRaw` | Total of confirmed matching payments |
| `metadata` | App context — always off-chain |

### Statuses

- **`open`** — active, can still be satisfied by incoming confirmed payments
- **`completed`** — collection rule satisfied by confirmed payment(s)
- **`expired`** — validity window ended before completion
- **`canceled`** — intentionally closed before completion

All terminal statuses (`completed`, `expired`, `canceled`) are irreversible.

## Payment

```typescript
type PaymentStatus = 'confirmed';

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

A payment represents a **confirmed matching payment fact** — not a provisional observation. The key identity comes from the confirmed send block.

## Events

Five canonical events:

```typescript
type RaiFlowEventType =
  | 'invoice.created'
  | 'payment.confirmed'
  | 'invoice.completed'
  | 'invoice.expired'
  | 'invoice.canceled';
```

### Envelope

Every event uses a typed envelope:

```typescript
interface EventEnvelope<TType extends RaiFlowEventType, TData> {
  id: string;
  type: TType;
  createdAt: string;
  data: TData;
}
```

### invoice.created

A new payment expectation exists.

```typescript
type InvoiceCreatedEvent = EventEnvelope<
  'invoice.created',
  { invoice: Invoice }
>;
```

### payment.confirmed

RaiFlow verified a confirmed Nano send block matching the expectation. **This is the key event.**

It means:
- value has been sent to the destination address
- the send block is confirmed
- the payment is a valid payment proof

It does **not** mean the invoice is fully satisfied or that the payment arrived before expiry.

```typescript
type PaymentConfirmedEvent = EventEnvelope<
  'payment.confirmed',
  { payment: Payment; invoice: Invoice }
>;
```

Both payment and invoice are included — most app logic wants both.

### invoice.completed

The invoice's completion rule is satisfied by one or more confirmed payments.

```typescript
type InvoiceCompletedEvent = EventEnvelope<
  'invoice.completed',
  { invoice: Invoice }
>;
```

### invoice.expired

The invoice ceased being collectible before completion. An expired invoice may still have received partial payment — expiry is a business rule, not a chain fact.

```typescript
type InvoiceExpiredEvent = EventEnvelope<
  'invoice.expired',
  { invoice: Invoice }
>;
```

### invoice.canceled

The invoice was intentionally closed. Business-driven, not chain-driven.

```typescript
type InvoiceCanceledEvent = EventEnvelope<
  'invoice.canceled',
  { invoice: Invoice }
>;
```

## Invariants

1. **Terminal statuses are irreversible** — `completed`, `expired`, `canceled` never revert to `open`
2. **Confirmed amount is monotonic** — `confirmedAmountRaw` never decreases
3. **Completion requires confirmed payment** — not provisional observation
4. **Confirmation is idempotent** — same send block never produces duplicate effects

## What is intentionally not canonized

These may be added later as advanced extensions, but are not part of the first model:

- `payment.detected` / `payment.observed` / `payment.receivable`
- `invoice.partially_paid` / `invoice.awaiting_confirmation`
- `webhook.delivery_failed`

See [RFC 0003](/rfcs/0003-event-model) for the full rationale.
