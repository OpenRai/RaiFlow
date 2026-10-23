# Roadmap

RaiFlow's active milestone is commerce reliability and a small high-level API,
tracked by Beads epic `RaiFlow-7w6`. Run `bd ready` for the current work queue;
Beads owns issue status and dependencies.

The runtime currently provides managed and watched accounts, confirmed deposit
history, invoices, durable sends and refunds, persisted events, webhook delivery,
RPC failover, work generation, and pre-signed block publishing. The SDK and
runtime use `/v1`.

Storage budgets (`RaiFlow-7w6.28`) retain all evidence and pause new inbound
processing at the global database byte cap or per-destination deposit limit.
The configured receive minimum still rejects dust before persistence. All
implementation issues in the current epic are complete; Beads tracks any new
follow-up work.

See the [runtime guide](./runtime/) and [progress notes](https://github.com/openrai/raiflow/blob/main/docs/progress.md)
for implementation details.
