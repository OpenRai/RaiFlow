# RaiFlow Progress

**Last updated:** 2026-10-20

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
pre-signed publishing have independent use cases. Legacy invoice adapters
remain in the runtime and require convergence onto canonical contracts.

The 2026-10-20 source review found incorrect recipient balance/frontier updates,
ambiguous send replay, non-atomic payment transitions, incomplete commerce
exception handling, and volatile webhook retries. Existing code and past
milestone labels do not establish those guarantees. The corresponding Beads
issues describe the evidence and required outcomes.

The local checkout includes uncommitted health/deployment changes, SSE fixes,
invoice lookup, and receive-block confirmation tracking. Preserve these while
repairing the affected flows. The game-specific allocator and manual receive
routes are obsolete; the receive worker remains internal.

`@openrai/nano-core` owns protocol primitives, block codecs, and supported
transport/work interfaces. OWS owns key isolation. RaiFlow owns payment
orchestration and durable business state. The pinned OWS revision already
supports indexed derivation/signing; avoid assuming default upstream `main`
contains those fork changes.
