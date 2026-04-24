# @openrai/webhook

Webhook signing, verification, and delivery helpers for RaiFlow.

This package provides the HMAC signing and verification primitives used for RaiFlow webhook
delivery, along with a small delivery engine and endpoint store helpers.

## Install

```bash
pnpm add @openrai/webhook
```

## What It Exports

- `signPayload`
- `verifySignature`
- `createWebhookDelivery`
- `createWebhookEndpointStore`

It also re-exports the relevant webhook and event types from `@openrai/model`.

## Example

```ts
import { signPayload, verifySignature } from '@openrai/webhook';

const payload = JSON.stringify({ ok: true });
const signature = signPayload(payload, 'top-secret');

const valid = verifySignature(payload, signature, 'top-secret');
```

## Related Packages

- `@openrai/model` — canonical event and webhook types
- `@openrai/raiflow-sdk` — client package that re-exports signature verification helpers

## Docs

- Repo: `https://github.com/OpenRai/RaiFlow`
