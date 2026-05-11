---
"@openrai/model": minor
"@openrai/raiflow-sdk": minor
"@openrai/webhook": minor
---

Account Watch Pool & Real-Time Event Fan-Out

- Add `AccountEvent` types (`account.state_synced`, `account.payment_received`, `account.balance_updated`, `account.frontier_updated`) to `@openrai/model`
- Add `AccountStateSync` to runtime for initial sync and 30s periodic reconciliation of watched accounts
- Add `SubscriptionManager` for deduplicating SSE connections and fanning out account events
- Add `GET /api/accounts/stream` SSE endpoint with `X-Raiflow-Stream-Id` header
- Add `POST /api/accounts/:id/watch` and `DELETE /api/accounts/:id/watch` endpoints for dynamic subscribe/unsubscribe
- Add `SseConnection` to `@openrai/raiflow-sdk` with auto-reconnect and shared stream
- Add `accounts.watch(accountId)` returning `AsyncIterable<AccountEvent>` backed by SSE
- Fix `SendOrchestrator` to fail sends on transient RPC errors instead of falling back to zero state
- Fix `accountInfo` in RPC client to return `undefined` for unopened accounts instead of throwing
