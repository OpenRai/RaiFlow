# @openrai/model

Canonical shared types and contracts for RaiFlow.

This package is the contract layer for the RaiFlow runtime and SDK. It contains the core
resource shapes, event types, statuses, request types, and shared error types used across the
published `@openrai/*` packages in this repo.

## What It Contains

- invoice, payment, account, send, and webhook resource types
- event envelope and event type unions
- request and query types shared by the runtime and SDK
- shared RaiFlow error types

## What It Does Not Contain

`@openrai/model` is intentionally logic-free. Do not put runtime orchestration, storage code,
RPC code, or application behavior here.

## Install

```bash
pnpm add @openrai/model
```

## Example

```ts
import type {
  Account,
  Invoice,
  RaiFlowEvent,
  Send,
  WebhookEndpoint,
} from '@openrai/model';
```

## Related Packages

- `@openrai/raiflow-sdk` — typed JS/TS client for the RaiFlow runtime
- `@openrai/webhook` — signing, verification, and delivery helpers

## Docs

- Repo: `https://github.com/OpenRai/RaiFlow`
- Runtime model docs: `https://github.com/OpenRai/RaiFlow/tree/main/apps/site/docs/runtime/model.md`
