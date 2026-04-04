# RaiFlow

RaiFlow is a self-hostable Nano runtime for application developers.

It is intended to sit between your app and one or more Nano nodes so your application does not need to own raw RPC handling, payment-event plumbing, block publishing flow, or custody-related mechanics directly.

## Current Status

RaiFlow is in a v2 rebuild.

What exists now:

- config loading from `raiflow.yml`
- SQLite-backed storage and migrations
- event persistence primitives
- RPC and WebSocket client primitives
- custody primitives for derivation, signing, and work generation
- a transitional runtime that still carries some prototype-era invoice behavior

What is still being built:

- the rebuilt wallet domain
- the rebuilt invoice domain on top of the new packages
- the final runtime API surface
- auth and recovery hardening

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
