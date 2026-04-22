---
"@openrai/model": minor
"@openrai/raiflow-sdk": minor
---

Expose Account and Send resources through the runtime HTTP API and SDK. Added `SendOrchestrator` for background send lifecycle management (`queued` → `published` → `confirmed`/`failed`). Added `listByStatus` and `getByBlockHash` to `SendStore`. Added `AccountsResource` and `SendsResource` to `@openrai/raiflow-sdk`.
