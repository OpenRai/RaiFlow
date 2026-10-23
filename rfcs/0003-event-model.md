# RFC 0003 — Event Model

This RFC defines the canonical event model for RaiFlow: resource shapes, event taxonomy, delivery semantics, and idempotency invariants.

## Current delivery contract — 2026-10-22

Webhook signatures use `X-RaiFlow-Signature: sha256=<hex>` over the exact JSON
request body. A successful 2xx response completes delivery. Most 4xx responses
are terminal; 408 and 429, 5xx, and network failures are retried. Runtime
delivery attempts and outcomes are persisted in the outbox system described
below. These details supersede older retry and signature examples later in this
RFC. The SDK and runtime event endpoints use `/v1/events`; event cursors are
monotonic sequence values.

## Storage pressure and inbound pause — 2026-10-23

RaiFlow retains deposit, payment, event, webhook, and recovery evidence without
automatic expiration. `storage.maxDatabaseBytes` (default 1 GiB) caps SQLite
database pages; inbound ingestion pauses before the byte limit to leave room for
WAL and recovery writes. `storage.maxDepositsPerAccount` (default 100,000)
limits retained confirmed deposits per destination Nano address. Both support
dedicated environment overrides. `GET /health/storage` reports database usage
and whether inbound processing is paused.

When a limit is reached, new deposit, payment, event, outbox, and receive-task
records are not written. The source transfer remains receivable on the Nano
node. Polling retries it, and account-history recovery does not advance its
cursor beyond an unpersisted transfer. Existing deposit replays and recovery
for sends or receives already in flight continue. Raise the limit and restart
to resume. No per-hash ignored-transfer record is created.

---

## Summary

Every state change in RaiFlow emits a persisted, ordered event. Events are the source of truth for webhooks, WebSocket subscriptions, and internal reactions. Delivery failure does not lose the event.

---

## Design Principles

1. **Every state change emits an event.** No silent mutations.
2. **Events are persisted before delivery is attempted.**
3. **Events are ordered** per resource. Global ordering is best-effort.
4. **Events are self-contained.** Each event embeds the full relevant resource state, not just an ID.
5. **Consumers handle duplicates.** RaiFlow targets at-least-once delivery. Use the event `id` for deduplication.

## Confirmed-deposit transaction — 2026-10-22

For an admitted confirmed inbound send, SQLite commits the unique deposit, optional
invoice payment, invoice amount/status transition, associated business events,
and owned receive-task intent in one transaction. Runtime listeners and webhook
delivery run after commit; failures there leave the persisted events available
for replay. A source-send hash is the deduplication identity, so replay does not
add a second payment contribution or completion transition.

Inbound admission applies an inclusive per-transfer minimum before this
transaction: `receiving.minimumAmountXno`, overridden at startup by
`RAIFLOW_MINIMUM_RECEIVE_AMOUNT_XNO`, defaults to `"0.000001"` XNO. Embedded
runtimes use `RuntimeConfig.minimumReceiveAmountXno`. Values are positive decimal
strings converted exactly through nano-core. Live observations, historical
recovery, and receivable discovery share the policy. Below-minimum sends create
no deposit, payment, event, receive task, or persistent ignored-hash record;
they do not accumulate toward invoices. New invoices below the minimum fail.
Operation confirmation and saved signed-block recovery continue after a minimum
increase. Existing records are retained; changing the minimum does not rebuild
skipped history. A minimum is an admission policy, and storage budgets and
retention remain necessary to bound above-minimum traffic.

Invoice completion, expiry, and cancellation are terminal transitions from
`open`. SQLite lifecycle updates compare the expected current status under an
immediate transaction. Confirmed payment ingest uses the same transaction
boundary, so whichever transition commits first determines the invoice result;
a later send to an expired or completed destination is recorded as a late
deposit without reopening or fulfilling another invoice. Configured default
expiry is applied at creation, and caller-provided expiry values must be valid
future date-times.

## Transactional webhook outbox — 2026-10-22

Persisting an event also creates one durable outbox job for each webhook
endpoint that matches the event at commit time. The event and its endpoint
delivery intents are inserted in the same SQLite transaction. Confirmed-deposit
ingestion uses that fan-out inside its existing domain transaction. A
background worker leases due jobs and performs HTTP outside domain transitions;
expired leases are eligible for recovery after a crash. Delivery attempts are
recorded separately, and retries keep the original event ID and payload.
The event row cannot be removed while an outbox job still references it, so
retention cleanup must preserve payloads for pending delivery.

Endpoint matching accepts `*`, exact event types, and namespace patterns such
as `invoice.*`. New webhook endpoints receive events created after they are
registered; creating an endpoint does not enqueue the historical event log.

---

## Event Envelope

Every event shares a common envelope:

```typescript
interface RaiFlowEvent {
  id: string           // Stable event identifier; consumers deduplicate by id
  type: string         // Dot-namespaced event type
  timestamp: string    // ISO 8601
  data: Record<string, unknown> // Event-type-specific payload
  resourceId: string  // ID of the primary resource
  resourceType: string // includes 'deposit' for inbound transfer observations
}
```

---

## Event Taxonomy

### Invoice Domain

| Event | Fires when |
|---|---|
| `invoice.created` | New invoice created |
| `invoice.payment_received` | A matching block detected (pending) |
| `invoice.payment_confirmed` | A matching block confirmed |
| `invoice.completed` | Total confirmed ≥ expected amount |
| `invoice.expired` | Expiry timer fired while still open |
| `invoice.canceled` | Developer canceled the invoice |
| `invoice.swept` | Collected funds swept to treasury |

### Deposit Domain

| Event | Fires when |
|---|---|
| `deposit.observed` | A confirmed inbound send is durably recorded with its disposition |

Each deposit records whether it is `matched`, `partial`, `excess`, `late`, or
`unmatched`. Late deposits link to their original invoice when known and never
fulfill a different invoice at the same legacy destination.

### Wallet Domain — Account

| Event | Fires when |
|---|---|
| `account.created` | Managed or watched account added |
| `account.received` | Inbound block detected on any account |
| `account.balance_updated` | Confirmed balance changed |
| `account.removed` | Account deleted or watch stopped |

### Wallet Domain — Send

| Event | Fires when |
|---|---|
| `send.queued` | Send operation accepted |
| `send.published` | Block published to network |
| `send.confirmed` | Block confirmed |
| `send.failed` | Rejected, timeout, or fork |

### Wallet Domain — Block

| Event | Fires when |
|---|---|
| `block.published` | Pre-signed block published |
| `block.confirmed` | Pre-signed block confirmed |
| `block.failed` | Pre-signed block rejected |

### Infrastructure

| Event | Fires when |
|---|---|
| `rpc.connected` | WebSocket connection established |
| `rpc.disconnected` | WebSocket connection lost |
| `rpc.failover` | Switched to backup node |

---

## Resource Shapes

### Invoice

```typescript
interface Invoice {
  id: string
  status: InvoiceStatus
  payAddress: string          // Derived Nano address for this invoice
  expectedAmountRaw: string   // Requested amount in raw
  receivedAmountRaw: string   // Total confirmed received in raw
  memo: string | null
  metadata: Record<string, string> | null
  idempotencyKey: string | null
  expiresAt: string | null
  completedAt: string | null
  canceledAt: string | null
  createdAt: string
  updatedAt: string
  completionPolicy: CompletionPolicy
}

type InvoiceStatus = 'open' | 'completed' | 'expired' | 'canceled'

type CompletionPolicy =
  | { type: 'at_least' }  // >= expectedAmountRaw (default)
  | { type: 'exact' }    // === expectedAmountRaw
```

### Payment

```typescript
interface Payment {
  id: string
  invoiceId: string
  status: PaymentStatus
  blockHash: string
  senderAddress: string | null
  amountRaw: string
  confirmedAt: string | null
  detectedAt: string
}

type PaymentStatus = 'pending' | 'confirmed' | 'failed'
```

### Account

```typescript
interface Account {
  id: string
  type: AccountType
  address: string
  label: string | null
  balanceRaw: string
  pendingRaw: string
  frontier: string | null
  representative: string | null
  derivationIndex: number | null  // null for watched accounts
  createdAt: string
  updatedAt: string
}

type AccountType = 'managed' | 'watched'
```

### Send

```typescript
interface Send {
  id: string
  accountId: string
  destination: string
  amountRaw: string
  status: SendStatus
  blockHash: string | null
  idempotencyKey: string
  createdAt: string
  publishedAt: string | null
  confirmedAt: string | null
}

type SendStatus = 'queued' | 'published' | 'confirmed' | 'failed'
```

### WebhookEndpoint

```typescript
interface WebhookEndpoint {
  id: string
  url: string
  secret: string
  eventTypes: string[]   // e.g. ['invoice.*'] or ['send.confirmed']
  createdAt: string
}
```

---

## Delivery Semantics

**At-least-once delivery.** Events may be delivered more than once. Consumers must handle duplicates idempotently using the event `id`.

### Retry Policy

- Up to 5 retries after the first attempt (6 total attempts)
- Exponential backoff: 1s, 2s, 4s, 8s, 16s
- Jitter: ±25% randomization to avoid thundering herd
- Non-2xx responses trigger retry, except terminal 4xx responses
- Network failures trigger retry
- `4xx` responses do not retry (client error)

### Webhook Signing

Every delivery is signed with HMAC-SHA256.

```
X-RaiFlow-Signature: sha256=<hex_digest>
X-RaiFlow-Event: <event.type>
X-RaiFlow-Event-Id: <event.id>
```

The signed payload is the raw JSON body.

### Event Polling

Events are persisted and queryable:

```
GET /v1/events?after=<cursor>&type=<filter>&limit=50
```

Cursor-based pagination using event `id` as the cursor. This provides a catch-up mechanism for consumers that cannot maintain a WebSocket connection.

---

## Idempotency Invariants

These are non-negotiable:

1. **Payment confirmation is idempotent.** The same confirmed send block hash must not produce duplicate `Payment` records or duplicate `payment.confirmed` events.
2. **Send operations are idempotent by idempotency key.** Replaying a send with the same idempotency key returns the original result without re-executing.
3. **Invoice creation is idempotent by idempotency key.** Replaying with the same key returns the existing invoice.
4. **Completion is terminal.** Once `invoice.status === 'completed'`, it must not later become `open`.
5. **Confirmed amount is monotonic.** `receivedAmountRaw` never decreases.
6. **Confirmed balance is monotonic.** Account `balanceRaw` never decreases without a corresponding send record.

---

## What Is Intentionally Not Canonized Yet

These may be added when proven necessary:

- `payment.detected` / `payment.observed` — RaiFlow only records confirmed payments as first-class `Payment` records. Pending observations are internal.
- `invoice.partially_paid` — derived from `receivedAmountRaw < expectedAmountRaw` on an open invoice, not a separate status.
- `webhook.delivery_failed` — tracked in delivery log, not a separate emitted event type for v1.
- Per-event delivery receipts in the event itself — delivery state lives in the webhook delivery log.

Canonizing these prematurely risks making RaiFlow feel more complex than Nano requires.
