# Implementation and RFC Alignment

**Audit date:** 2026-10-23
**Scope:** Current commerce runtime and SDK compared with root documentation and
RFCs. Beads tracks remaining implementation work.

## Aligned and implemented

- Runtime and SDK use the `/v1` route prefix.
- API key and mode are required at startup; custodial setup is validated through
  the configured OWS provider.
- Managed and watched accounts, sends, invoices, deposits, explicit refunds,
  event polling/streaming, webhooks, work generation, and pre-signed publishing
  are exposed by the runtime and SDK.
- Refunds link to confirmed deposits and durable sends. The application supplies
  and verifies the destination; RaiFlow does not infer a refund address from
  the incoming sender.
- Webhook events and endpoint-scoped delivery jobs are persisted before
  delivery. Retry attempts and outcomes are durable.
- Custodial send and receive operations serialize by account and persist signed
  intents for restart recovery. RPC calls, startup probes, and runtime
  observation share nano-core transport helpers.
- `receiving.minimumAmountXno` is a first-class config value, supports an
  environment override, and is also available to embedded `Runtime` users.
  Dust below the threshold is rejected before deposit/payment/event persistence
  and receive-job creation.
- Example applications and the SDK have been rebuilt against the commerce API.

## Remaining decisions and gaps

- `RaiFlow-7w6.28`: implemented and validated. The selected keep-all-evidence
  policy caps SQLite pages and deposit records per destination, then pauses
  inbound writes without advancing recovery cursors. It does not delete history.
- RFCs retain historical context where useful. Current README, SDK reference,
  and runtime docs describe operational behavior.
- Destination identity verification for refunds belongs to the integrating
  application; the runtime requires an explicit destination but cannot prove
  that it belongs to the customer.

## Completed epic work

See Beads for status. Completed work includes canonical runtime model
convergence (`.22`), RPC transport convergence (`.20`), SDK convergence (`.23`),
example rebuilds (`.24`), explicit refund linkage (`.15`), and docs/RFC
reconciliation (`.25`).
