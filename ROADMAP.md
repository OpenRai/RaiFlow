# Roadmap

This file tracks where RaiFlow is headed and what is actually in flight.

It is not a launch checklist and it is not written as product copy. The point is to show what exists, what is partially connected, and what still needs to be built.

## Current State

Implemented in the repository today:

- `packages/config` with YAML loading and `env:` resolution
- `packages/storage` with SQLite support, migration runner, and store adapters
- `packages/events` with event bus and persisted event wrapper
- `packages/rpc` with Nano RPC and WebSocket primitives
- `packages/custody` with derivation, signing, and work-generation primitives
- runtime bootstrap from config with database startup and migrations

Still incomplete at the runtime/product level:

- wallet-domain services are not fully exposed through the runtime API
- invoice v2 has not fully replaced the prototype-era runtime behavior
- auth, recovery, and hardening are not finished
- examples and site docs are still catching up in places

## Milestones

### M1 — Foundation

Mostly implemented:

- [x] Typed YAML config loader with `env:` resolution
- [x] SQLite storage with forward-only migration runner
- [x] Initial schema for invoices, payments, accounts, sends, events, webhooks, and migrations
- [x] Persisted event log base implementation
- [x] In-process event bus
- [x] Daemon bootstrap from config and storage
- [ ] API key authentication on all mutating endpoints
- [ ] Request correlation IDs and stronger readiness semantics
- [ ] Complete removal of prototype-era domain wiring from the runtime

### M2 — RPC and Custody Core

Core primitives implemented:

- [x] Multi-node RPC client foundation
- [x] WebSocket confirmation client foundation
- [x] Seed loading and deterministic derivation primitives
- [x] Block construction and signing primitives
- [x] PoW generation abstraction
- [ ] Runtime-level infrastructure events like `rpc.connected` and `rpc.failover`
- [ ] Frontier tracking integrated into wallet services
- [ ] Full end-to-end use through runtime APIs

### M3 — Wallet Domain

Current active build focus:

- [ ] Create managed accounts from seed
- [ ] List, get, update, delete managed accounts
- [ ] Watch external accounts
- [ ] Balance and frontier tracking
- [ ] Auto-receive pending blocks on managed accounts
- [ ] Idempotent sends from managed accounts
- [ ] Send state machine: `queued -> published -> confirmed | failed`
- [ ] Pre-signed block publishing API
- [ ] Work generation API

### M4 — Invoice Domain Rebuild

- [ ] Pay-address derivation per invoice
- [ ] Invoice lifecycle rebuilt on the new storage/custody stack
- [ ] Payment detection and matching on the new runtime path
- [ ] Completion, expiry, and cancellation rules
- [ ] Partial and overpayment recording
- [ ] Treasury sweep through the wallet send pipeline

### M5 — Delivery Surfaces

- [ ] Global event polling API
- [ ] Persisted webhook delivery attempts
- [ ] Webhook retry scheduling and recovery
- [ ] WebSocket event subscriptions

### M6 — SDK and Examples

- [ ] `@openrai/raiflow-sdk` aligned with the rebuilt runtime API
- [ ] Express example rebuilt for v2
- [ ] Next.js checkout example rebuilt for v2
- [ ] Webhook consumer example rebuilt for v2
- [ ] HTMX wallet example rebuilt for v2

### M7 — Hardening

- [ ] Restart recovery and in-flight operation resumption
- [ ] Integration tests against a Nano test environment
- [ ] Security review for seed handling, auth, webhook verification, and send safety
- [ ] Docker image
- [ ] Deployment documentation

## Replacement Note

This roadmap replaces the old prototype-phase roadmap.

The important distinction is:

- the prototype proved the shape of the system
- the current work is replacing that prototype with a proper runtime

See `rfcs/0001-project-framing.md` for the framing behind that shift.
