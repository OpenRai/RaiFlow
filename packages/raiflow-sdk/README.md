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
  basePath: '/api',                   // optional, default: "/api"
});
```

Resource accessors:

- `client.accounts` — `AccountsResource`
- `client.blocks` — `BlocksResource`
- `client.invoices` — `InvoicesResource`
- `client.sends` — `SendsResource`
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
  idempotencyKey: 'create-primary', // optional but recommended
});
```

#### `createWatched(options)`

Create a watched account for an external address you do not control.

```ts
const account = await client.accounts.createWatched({
  address: 'nano_1...',
  label: 'Exchange deposit',
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
});
```

#### `receivable(id)`

Fetch pending receivable blocks for the account's address from the connected Nano node.

```ts
const { data } = await client.accounts.receivable('acc_...');
```

---

### `InvoicesResource`

Create payment expectations and track their lifecycle.

> Invoices require custodial mode. Non-custodial runtimes reject these requests with HTTP 501.

#### `create(options, idempotencyKey?)`

Create a new invoice. The `idempotencyKey` header is sent automatically when provided.

```ts
const invoice = await client.invoices.create(
  {
    recipientAccount: 'acc_...',
    expectedAmountRaw: '1000000000000000000000000000000',
    expiresAt: '2026-12-31T23:59:59Z',      // optional
    metadata: { orderId: '123' },            // optional
    completionPolicy: { type: 'exact' },     // optional: "exact" | "at_least"
  },
  'invoice-order-123',                       // optional idempotency key
);
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
const pending = await client.invoices.list({ status: 'pending' });
```

#### `cancel(id)`

Cancel a pending invoice.

```ts
const cancelled = await client.invoices.cancel('inv_...');
```

#### `listPayments(id)`

List payments matched to an invoice.

```ts
const { data } = await client.invoices.listPayments('inv_...');
```

#### `listEvents(id, options?)`

List events for an invoice, optionally paginated with `after`.

```ts
const { data } = await client.invoices.listEvents('inv_...');
const later = await client.invoices.listEvents('inv_...', { after: 'evt_...' });
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

---

### `WebhooksResource`

Register webhook endpoints for event delivery.

#### `create(options)`

Register a new webhook endpoint.

```ts
const endpoint = await client.webhooks.create({
  url: 'https://example.com/webhooks/raiflow',
  eventTypes: ['invoice.completed', 'send.confirmed'],
  secret: 'whsec_...', // optional
});
```

#### `list()`

List all registered webhook endpoints.

```ts
const { data } = await client.webhooks.list();
```

#### `delete(id)`

Remove a webhook endpoint.

```ts
await client.webhooks.delete('whk_...');
```

---

### `SystemResource`

#### `health()`

Check runtime health.

```ts
const health = await client.system.health();
// => { status: "ok" }
```

---

### `BlocksResource`

Low-level block publishing for pre-signed blocks.

> This is an escape hatch for non-custodial flows where blocks are signed client-side (e.g., a browser wallet or thin client). For custodial flows, use `SendsResource` — RaiFlow handles signing and PoW automatically.

#### `publish(block)`

Publish a pre-signed block JSON string to the network.

```ts
const result = await client.blocks.publish('{"block":"..."}');
// => { hash: "ABC123..." }
```

---

### `WorkResource`

Low-level work generation for non-custodial flows.

> If you find yourself using this directly, it usually indicates a missing SDK feature. For custodial flows, RaiFlow generates work automatically.

#### `generate(hash, difficulty?, blockType?)`

Generate proof-of-work for a block hash.

```ts
const result = await client.work.generate('ABC123...');
// => { work: "1f0e2d..." }

const withDifficulty = await client.work.generate('ABC123...', 'fffffff800000000');
const receiveWork = await client.work.generate('ABC123...', undefined, 'receive');
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
  Receivable,
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
