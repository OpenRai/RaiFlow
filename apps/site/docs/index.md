# RaiFlow

RaiFlow is a self-hostable Nano runtime for application developers.

It is intended to sit between your app and one or more Nano nodes so your application does not need to own raw RPC handling, payment-event plumbing, block publishing flow, or custody-related mechanics directly.

## Current Status

RaiFlow has a working commerce runtime with managed and watched accounts,
deposit tracking, invoices, durable sends and refunds, persisted events, and
webhook delivery. The SDK and HTTP API use `/v1`. Custodial operations require
custody configuration; non-custodial mode supports watched accounts, work, and
pre-signed block publishing.

The configured minimum inbound amount filters transfers before deposit,
payment, event, or receive-job persistence. Inbound storage budgets retain
evidence and pause processing at configured global and per-destination limits;
see the [runtime guide](./runtime/) and [roadmap](./roadmap).

## What RaiFlow Is Trying To Be

One runtime for two related jobs:

- **Invoice domain**: get paid, match incoming Nano payments, manage invoice lifecycle
- **Wallet domain**: operate Nano accounts, send funds, publish pre-signed blocks, and generate work

Those domains share storage, events, RPC, and custody.

## Start Here

- [Runtime](./runtime/) for the current runtime shape and caveats
- [Roadmap](./roadmap) for what is built vs what is next
- [RFCs](./rfcs/) for the architectural decisions behind the v2 design

## Repository Layout

| Package | Role |
|---|---|
| `@openrai/model` | canonical types and contracts |
| `@openrai/config` | YAML config loading |
| `@openrai/storage` | SQLite storage and migrations |
| `@openrai/rpc` | Nano RPC and WebSocket primitives |
| `@openrai/events` | event bus and persisted event access |
| `@openrai/custody` | derivation, signing, and work generation |
| `@openrai/runtime` | HTTP runtime and orchestration |
| `@openrai/webhook` | webhook signing and delivery |
| `@openrai/raiflow-sdk` | typed JS/TS client |
