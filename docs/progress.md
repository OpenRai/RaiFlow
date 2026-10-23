# RaiFlow Progress

**Last updated:** 2026-10-23

## Active Milestone

**Commerce reliability and a small high-level API — Beads epic `RaiFlow-7w6`.**

Run `bd show RaiFlow-7w6` for the scope and `bd ready` for available work.
Beads owns priorities, dependencies, acceptance criteria, and completion state.

The target integrations are external-wallet checkout, reusable customer
payment/deposit accounts, and custodial withdrawals. Applications issue intents
and consume durable business events. Receiving, signing, work, frontiers,
confirmation recovery, and settlement housekeeping belong to the runtime.
RFC 0001 records this scope and the removal of Nanosweeper-specific controls.
There are no known commercial users; backwards compatibility does not constrain
API or internal refactoring.

## Implementation Context

Invoice and wallet domains share SQLite, RPC, OWS custody, and events. The SDK
and canonical HTTP routes use `/v1`. Managed accounts, watched accounts, and
pre-signed publishing have independent use cases. The runtime now consumes the
canonical invoice, payment, event, and store contracts directly.

Inbound admission applies the configured per-transfer minimum first. Storage
budgets in `.28` then cap SQLite pages and retained deposits per destination
address. The selected policy is to preserve all evidence and pause new inbound
persistence at a limit. Existing records and operation recovery remain
available; pending source sends stay on the Nano node and recovery cursors do
not advance past unpersisted history. Limits are applied at startup. No
retention cleanup will remove history.

Invoice settlement uses explicit invoice-source sends through the shared
durable send pipeline. Invoice destinations remain one-time collection targets,
not reusable managed accounts.

Webhook events enqueue endpoint-scoped jobs in the event transaction. A leased
worker retries delivery with durable attempt history; the public-interface
recovery scenarios in `.26` now exercise ambiguous sends, duplicate requests and
deposits across restarts, concurrent sends and receives, webhook outages, and
sweep recovery through SQLite-backed runtime instances and a controlled fake
node. SDK convergence in `.23`, example rebuilds in `.24`, and RPC transport
convergence in `.20` are complete. RPC calls, startup probes, and runtime
watcher observation share nano-core endpoint normalization, Bearer auth,
credential redaction, failover, and rate-limit handling; work generation uses
the injected nano-core `WorkProvider`.

Refund reservations and linked sends are stored atomically, with destination
and identity verification policy left to the application. `.28` now enforces
the selected storage policy: `/health/storage` reports pressure, the default
database cap is 1 GiB, and the default retained-deposit cap is 100,000 per
destination address. Build, test, and docs validation pass. The per-transfer
minimum rejects dust before these storage budgets are evaluated.

The game-specific allocator and manual receive routes are obsolete; the
receive worker remains internal.

`@openrai/nano-core` owns protocol primitives, block codecs, and supported
transport/work interfaces. OWS owns key isolation. RaiFlow owns payment
orchestration and durable business state. The pinned OWS revision already
supports indexed derivation/signing; avoid assuming default upstream `main`
contains those fork changes.
