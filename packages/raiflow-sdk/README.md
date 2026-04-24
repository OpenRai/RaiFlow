# @openrai/raiflow-sdk

Typed JavaScript and TypeScript client for the RaiFlow runtime.

Use this package when your application talks to a running RaiFlow instance over HTTP.

## Install

```bash
pnpm add @openrai/raiflow-sdk
```

## Example

```ts
import { RaiFlowClient } from '@openrai/raiflow-sdk';

const client = RaiFlowClient.initialize({
  baseUrl: 'http://127.0.0.1:3100',
  apiKey: process.env['RAIFLOW_API_KEY'],
});

const health = await client.system.health();
console.log(health.status);
```

## What It Exposes

- `RaiFlowClient`
- resource clients for accounts, invoices, sends, system, and webhooks
- canonical RaiFlow types re-exported from `@openrai/model`
- webhook signing helpers re-exported from `@openrai/webhook`

## Notes

- The SDK targets the RaiFlow runtime API, not raw Nano JSON-RPC.
- `@openrai/nano-core` remains a separate lower-level package and repo.

## Related Packages

- `@openrai/model` — canonical shared types and request shapes
- `@openrai/webhook` — webhook helpers used by the runtime and re-exported here

## Docs

- Repo: `https://github.com/OpenRai/RaiFlow`
- Examples: `https://github.com/OpenRai/RaiFlow/tree/main/examples`
