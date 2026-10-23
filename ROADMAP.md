# Roadmap

## Current Milestone

Commerce reliability and a small high-level API — Beads epic `RaiFlow-7w6`.
Beads is the source of truth for issue status, dependencies, and acceptance
criteria. Use `bd ready` for the next available work.

The current runtime provides managed and watched accounts, confirmed deposit
history, invoices, durable sends and refunds, persisted events, webhook delivery,
RPC failover, work generation, and pre-signed block publishing. The SDK and
runtime use `/v1`.

## Remaining Work

The epic's implementation issues are complete. Run `bd ready` for any newly
unblocked work; Beads remains the source of truth for future scope.

## Architectural Boundaries

- `@openrai/model` owns canonical contracts; application orchestration belongs
  in runtime and domain packages.
- `@openrai/nano-core` owns Nano protocol primitives and transport/work
  interfaces.
- OWS owns key isolation and signing in custodial mode.
- RaiFlow owns payment orchestration, durable business state, and delivery.
- Invoice destinations are one-time collection addresses. Reusable customer
  deposit addresses are managed accounts.

See [progress](docs/progress.md) for current implementation context and the
[RFCs](rfcs/) for architectural decisions.
