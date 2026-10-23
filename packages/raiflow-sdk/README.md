# @openrai/raiflow-sdk

Typed JavaScript and TypeScript client for the RaiFlow runtime.

<!-- Badges placeholder -->

## Install

```bash
pnpm add @openrai/raiflow-sdk
```

## Quick Start

```ts
import { RaiFlowClient } from '@openrai/raiflow-sdk';

const client = RaiFlowClient.initialize({
  baseUrl: 'http://127.0.0.1:3100',
  apiKey: process.env['RAIFLOW_API_KEY']!,
});

const health = await client.system.health();
console.log(health.status);
```

## API Reference

### `RaiFlowClient`

Main entrypoint for the SDK.

```ts
const client = RaiFlowClient.initialize({
  baseUrl: 'http://127.0.0.1:3100',  // required
  apiKey: 'your-secret-key',          // required
  basePath: '/v1',                    // optional, default: "/v1"
});
```

Resource accessors:

- `client.accounts` — `AccountsResource`
- `client.deposits` — `DepositsResource` for explicit deposit refunds
- `client.blocks` — `BlocksResource`
- `client.invoices` — `InvoicesResource`
- `client.sends` — `SendsResource`
- `client.events` — `EventsResource` for durable event replay and streaming
- `client.system` — `SystemResource`
- `client.webhooks` — `WebhooksResource`
- `client.work` — `WorkResource`

---

### `AccountsResource`

Create and operate managed and watched accounts.

#### `createManaged(options)`

Create a custodial managed account. RaiFlow derives the address, holds the keys, and handles signing.

```ts
const account = await client.accounts.createManaged({
  label: 'Primary wallet',
  representative: 'nano_1...',      // optional
  idempotencyKey: 'create-primary', // required
});
```

#### `createWatched(options)`

Create a watched account for an external address you do not control.

```ts
const account = await client.accounts.createWatched({
  address: 'nano_1...',
  label: 'Exchange deposit',
  idempotencyKey: 'watch-exchange-deposit', // required
});
```

#### `list(options?)`

List all accounts. Optionally filter by `type`.

```ts
const { data } = await client.accounts.list();
const managed = await client.accounts.list({ type: 'managed' });
```

#### `get(id)`

Fetch a single account by ID.

```ts
const account = await client.accounts.get('acc_...');
```

#### `update(id, patch)`

Update an account's label or representative.

```ts
const updated = await client.accounts.update('acc_...', {
  label: 'New label',
  representative: 'nano_1...',
}, 'rename-primary-account');
```

#### `listDeposits(id)`

List confirmed inbound transfers for a managed or watched account. Use this for
account deposit history; receiving and pending-block handling stay inside the
runtime.

```ts
const { data } = await client.accounts.listDeposits('acc_...');
```

---

### `InvoicesResource`

Create payment expectations and track their lifecycle.

> Invoices require custodial mode. Non-custodial runtimes reject these requests with HTTP 501.

#### `create(options, idempotencyKey)`

Create a new invoice. Provide the amount as either an exact raw integer string or
an exact decimal XNO string. Do not provide both. Decimal values are converted
to raw units without floating-point arithmetic. The `idempotencyKey` is sent as
the required `Idempotency-Key` header.

Every call without `invoiceKey` creates a one-time invoice with its own payment
destination. Supply an `invoiceKey` to identify and replay the same invoice for
an application order. For reusable customer deposit accounts, create a managed
account with `client.accounts.createManaged()` instead of reusing an invoice.

```ts
const invoice = await client.invoices.create(
  {
    expectedAmountRaw: '1000000000000000000000000000000',
    accountKey: 'customer-123',
    expiresAt: '2026-12-31T23:59:59Z',      // optional
    metadata: { orderId: '123' },            // optional
    completionPolicy: { type: 'exact' },     // optional: "exact" | "at_least"
  },
  'invoice-order-123',
);

// Or use a decimal XNO string instead of expectedAmountRaw:
await client.invoices.create({ accountKey: 'customer-123', expectedAmount: '1.25' }, 'invoice-order-124');
```

#### `get(id)`

Fetch a single invoice.

```ts
const invoice = await client.invoices.get('inv_...');
```

#### `list(options?)`

List invoices. Optionally filter by `status`.

```ts
const { data } = await client.invoices.list();
const open = await client.invoices.list({ status: 'open' });
```

Use `listByAccountKey(accountKey)` to list a customer's invoices or
`getByKey(accountKey, invoiceKey)` to resolve the stable application reference.
When no `invoiceKey` is supplied to `create`, RaiFlow creates a distinct,
one-time payment destination.

#### `cancel(id, idempotencyKey)`

Cancel a pending invoice.

```ts
const cancelled = await client.invoices.cancel('inv_...', 'cancel-order-123');
```

#### `listPayments(id)`

List payments matched to an invoice.

```ts
const { data } = await client.invoices.listPayments('inv_...');
```

Read invoice lifecycle and payment events through the durable global event
feed, filtering by `resourceType: 'invoice'` and the invoice ID. Its cursor can
be stored and replayed after a disconnect or process restart.

---

### `DepositsResource`

Refund a confirmed deposit through the durable send pipeline, or list its refund
history. The application is responsible for verifying the destination and must
provide it explicitly. RaiFlow never defaults to the incoming sender address.
Refund totals cannot exceed the deposit amount while refunds are queued,
published, or confirmed. Each refund requires an idempotency key.

```ts
const refund = await client.deposits.refund(deposit.id, {
  destination: verifiedCustomerAddress,
  amountRaw: deposit.amountRaw,
  idempotencyKey: `refund-${deposit.id}`,
});

const { data: refunds } = await client.deposits.listRefunds(deposit.id);
```

---

### `SendsResource`

Queue and track outgoing transfers.

> Sends require custodial mode. Non-custodial runtimes reject these requests with HTTP 501.

#### `queue(accountId, options)`

Queue a send from a managed account. **Requires an `idempotencyKey`.**

```ts
const send = await client.sends.queue('acc_...', {
  destination: 'nano_1...',
  amountRaw: '1000000000000000000000000000000',
  idempotencyKey: 'send-order-456',
});
```

#### `listByAccount(accountId)`

List sends for a specific account.

```ts
const { data } = await client.sends.listByAccount('acc_...');
```

#### `get(id)`

Fetch a single send by its global ID.

```ts
const send = await client.sends.get('snd_...');
```

Every returned `Send` has a discriminated `source`. Managed-account sends use
`{ type: 'account', accountId, address, derivationIndex }`. Automatic invoice
settlement sends use `{ type: 'invoice', invoiceId, address, derivationIndex }`.
Invoice addresses remain one-time collection targets, not reusable accounts.

---

### `WebhooksResource`

Register webhook endpoints for event delivery.

#### `create(options, idempotencyKey)`

Register a new webhook endpoint.

```ts
const endpoint = await client.webhooks.create({
  url: 'https://example.com/webhooks/raiflow',
  eventTypes: ['invoice.completed', 'send.confirmed'],
  secret: 'whsec_...', // optional
}, 'register-checkout-webhook');
```

#### `list()`

List all registered webhook endpoints.

```ts
const { data } = await client.webhooks.list();
```

#### `delete(id)`

Remove a webhook endpoint with an idempotency key.

```ts
await client.webhooks.delete('whk_...', 'remove-checkout-webhook');
```

---

### `SystemResource`

#### `health()`

Check runtime health.

```ts
const health = await client.system.health();
// => { status: "ok" }
```

### `EventsResource`

Events are persisted in sequence. `after` is a replay cursor, so consumers can
resume from the last processed event after reconnecting or restarting.

```ts
const page = await client.events.list({
  after: '41',
  resourceType: 'invoice',
  resourceId: 'inv_...',
  limit: 100,
});

const cursor = page.nextCursor ?? String(page.data[page.data.length - 1]?.sequence ?? 41);
for await (const event of client.events.stream({ after: cursor })) {
  // Persist the cursor only after your application has handled the event.
}
```

---

### `BlocksResource`

Low-level block publishing for pre-signed blocks.

> This is an escape hatch for non-custodial flows where blocks are signed client-side (e.g., a browser wallet or thin client). For custodial flows, use `SendsResource` — RaiFlow handles signing and PoW automatically.

#### `publish(block, idempotencyKey)`

Publish a pre-signed block JSON string to the network.

```ts
const result = await client.blocks.publish('{"block":"..."}', 'publish-signed-block-123');
// => { hash: "ABC123..." }
```

---

### `WorkResource`

Low-level work generation for non-custodial flows.

> If you find yourself using this directly, it usually indicates a missing SDK feature. For custodial flows, RaiFlow generates work automatically.

#### `generate(hash)`

Generate proof-of-work for a block hash.

```ts
const result = await client.work.generate('ABC123...');
// => { work: "1f0e2d..." }

```

## Re-exported Types

The SDK re-exports all canonical types from `@openrai/model` so you do not need to install it separately:

```ts
import type {
  Invoice,
  InvoiceStatus,
  Payment,
  PaymentStatus,
  Account,
  AccountType,
  Send,
  SendStatus,
  RaiFlowEvent,
  RaiFlowEventType,
  CompletionPolicy,
  WebhookEndpoint,
  CreateInvoiceRequest,
  CreateAccountRequest,
  WatchAccountRequest,
  UpdateAccountRequest,
  SendRequest,
  PublishBlockRequest,
  WorkGenerateRequest,
  CreateWebhookRequest,
  EventQueryOptions,
  PaginatedEventsResponse,
  RaiFlowError,
} from '@openrai/raiflow-sdk';
```

## Re-exported Helpers

Webhook signature verification and signing helpers from `@openrai/webhook`:

```ts
import { verifySignature, signPayload } from '@openrai/raiflow-sdk';

const isValid = verifySignature(payload, signature, secret);
const signature = signPayload(payload, secret);
```

## Related Packages

- [`@openrai/model`](https://github.com/OpenRai/RaiFlow/tree/main/packages/model) — canonical shared types and request shapes
- [`@openrai/webhook`](https://github.com/OpenRai/RaiFlow/tree/main/packages/webhook) — webhook signing and delivery helpers used by the runtime
- [`@openrai/nano-core`](https://github.com/OpenRai/nano-core) — Nano protocol primitives (`NanoAmount`, `NanoAddress`, `NanoClient`, `WorkProvider`)

## Notes

- The SDK targets the RaiFlow runtime API, not raw Nano JSON-RPC.
- All mutating operations accept an idempotency key where the runtime expects one. Sends **require** an idempotency key — missing it results in rejection.
- `@openrai/nano-core` remains a separate lower-level package and repo.

## Docs

- Repository: `https://github.com/OpenRai/RaiFlow`
- Examples: `https://github.com/OpenRai/RaiFlow/tree/main/examples`
