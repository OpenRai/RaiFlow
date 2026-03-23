# Code Examples

Practical patterns for integrating with RaiFlow. These examples use the canonical model types from `@openrai/model`.

::: info STATUS
RaiFlow is in early development. These examples show the **target developer experience** — the API shape the runtime is being built toward.
:::

## Create an invoice

```typescript
import type { Invoice } from '@openrai/model';

const invoice: Invoice = {
  id: 'inv_001',
  status: 'open',
  currency: 'XNO',
  expectedAmountRaw: '10000000000000000000000000000000', // 10 XNO
  confirmedAmountRaw: '0',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min
  metadata: {
    orderId: 'order-abc-123',
    customerEmail: 'dev@example.com',
  },
};
```

No accounts to create, no keys to manage. The invoice is a payment expectation — you provide the address separately when configuring the watcher.

## Handle a confirmed payment

```typescript
import type { PaymentConfirmedEvent } from '@openrai/model';

function onPaymentConfirmed(event: PaymentConfirmedEvent) {
  const { payment, invoice } = event.data;

  console.log(`Payment ${payment.id} confirmed`);
  console.log(`  Amount: ${payment.amountRaw} raw`);
  console.log(`  Block:  ${payment.sendBlockHash}`);
  console.log(`  Invoice ${invoice.id} now at ${invoice.confirmedAmountRaw} / ${invoice.expectedAmountRaw}`);
}
```

The `payment.confirmed` event includes both the payment fact and the current invoice state. One event, both pieces of context.

## Handle invoice completion

```typescript
import type { InvoiceCompletedEvent } from '@openrai/model';

function onInvoiceCompleted(event: InvoiceCompletedEvent) {
  const { invoice } = event.data;

  // Grant access, mark order paid, unlock service
  console.log(`Invoice ${invoice.id} completed at ${invoice.completedAt}`);
  grantAccess(invoice.metadata?.orderId as string);
}
```

## Handle all events (webhook consumer)

```typescript
import type { RaiFlowEvent } from '@openrai/model';

function handleWebhook(event: RaiFlowEvent) {
  switch (event.type) {
    case 'invoice.created':
      // Start showing checkout UI
      break;

    case 'payment.confirmed':
      // Update payment progress
      break;

    case 'invoice.completed':
      // Grant access / mark paid
      break;

    case 'invoice.expired':
      // Show expiry notice, offer retry
      break;

    case 'invoice.canceled':
      // Clean up
      break;
  }
}
```

TypeScript narrows `event.data` automatically in each branch — no casts needed.

## Partial payments

Invoice expects 10 XNO. Customer sends in two parts:

```typescript
// First payment: 4 XNO
// event.type === 'payment.confirmed'
// event.data.payment.amountRaw === '4000000000000000000000000000000'
// event.data.invoice.status === 'open'
// event.data.invoice.confirmedAmountRaw === '4000000000000000000000000000000'

// Second payment: 6 XNO
// event.type === 'payment.confirmed'
// event.data.payment.amountRaw === '6000000000000000000000000000000'
// event.data.invoice.status === 'open'
// event.data.invoice.confirmedAmountRaw === '10000000000000000000000000000000'

// Immediately followed by:
// event.type === 'invoice.completed'
// event.data.invoice.status === 'completed'
```

Two `payment.confirmed` events, then one `invoice.completed`. Clean separation between payment facts and business completion.

## Verify a webhook signature

```typescript
import { createHmac } from 'node:crypto';

function verifySignature(body: string, secret: string, header: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return expected === header;
}

// In your HTTP handler:
const signature = req.headers['x-raiflow-signature'] as string;
const raw = JSON.stringify(req.body);

if (!verifySignature(raw, WEBHOOK_SECRET, signature)) {
  return res.status(401).send('Invalid signature');
}
```

## Idempotent event handling

Events are delivered at-least-once. Use the event `id` as a deduplication key:

```typescript
const processedEvents = new Set<string>();

function handleEvent(event: RaiFlowEvent) {
  if (processedEvents.has(event.id)) {
    return; // Already processed
  }
  processedEvents.add(event.id);

  // Process the event...
}
```

In production, use a persistent store instead of an in-memory set.
