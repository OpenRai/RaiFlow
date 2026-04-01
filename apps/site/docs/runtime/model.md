# Model

This page describes the canonical v2 model defined in `@openrai/model`.

Important distinction:

- this is the contract the project is converging on
- it is not a guarantee that every field and event family is already exercised through the current runtime API

For current runtime behavior, read the runtime and roadmap pages alongside this one.

## Invoice

```typescript
interface Invoice {
  id: string
  status: 'open' | 'completed' | 'expired' | 'canceled'
  payAddress: string
  expectedAmountRaw: string
  receivedAmountRaw: string
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

type CompletionPolicy =
  | { type: 'at_least' }
  | { type: 'exact' }
```

## Payment

```typescript
interface Payment {
  id: string
  invoiceId: string
  status: 'pending' | 'confirmed' | 'failed'
  blockHash: string
  senderAddress: string | null
  amountRaw: string
  confirmedAt: string | null
  detectedAt: string
}
```

## Account

```typescript
interface Account {
  id: string
  type: 'managed' | 'watched'
  address: string
  label: string | null
  balanceRaw: string
  pendingRaw: string
  frontier: string | null
  representative: string | null
  derivationIndex: number | null
  createdAt: string
  updatedAt: string
}
```

## Send

```typescript
interface Send {
  id: string
  accountId: string
  destination: string
  amountRaw: string
  status: 'queued' | 'published' | 'confirmed' | 'failed'
  blockHash: string | null
  idempotencyKey: string
  createdAt: string
  publishedAt: string | null
  confirmedAt: string | null
}
```

## Event Envelope

```typescript
interface RaiFlowEvent {
  id: string
  type: string
  timestamp: string
  data: Record<string, unknown>
  resourceId: string
  resourceType: 'invoice' | 'payment' | 'account' | 'send' | 'block' | 'rpc'
}
```

## Event Families

```text
Invoice:        invoice.created
                invoice.payment_received
                invoice.payment_confirmed
                invoice.completed
                invoice.expired
                invoice.canceled
                invoice.swept

Account:        account.created
                account.received
                account.balance_updated
                account.removed

Send:           send.queued
                send.published
                send.confirmed
                send.failed

Block:          block.published
                block.confirmed
                block.failed

Infrastructure: rpc.connected
                rpc.disconnected
                rpc.failover
```

See [RFC 0003](../rfcs/0003-event-model) for the fuller design rationale and delivery semantics.
