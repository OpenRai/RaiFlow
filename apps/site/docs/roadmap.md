# Roadmap

This roadmap distinguishes between foundation work that already exists in the repo and domain work that is still being wired through the runtime.

## Current Snapshot

Already implemented:

- config loading
- SQLite storage and migrations
- event persistence primitives
- RPC and WebSocket primitives
- custody primitives for derivation, signing, and work generation
- runtime bootstrap from config

Still in progress:

- wallet-domain runtime services
- invoice-domain rebuild
- final runtime API surface
- auth and operational hardening

## Milestones

### M1 — Foundation

- [x] config loader
- [x] SQLite storage
- [x] migration runner
- [x] event persistence base
- [x] runtime bootstrap
- [ ] full auth enforcement
- [ ] remaining prototype-runtime replacement

### M2 — RPC and Custody Core

- [x] RPC client foundation
- [x] WebSocket confirmation client foundation
- [x] derivation and signing primitives
- [x] work-generation abstraction
- [ ] runtime-level integration of those primitives

### M3 — Wallet Domain

- [ ] managed accounts
- [ ] watched accounts
- [ ] send pipeline
- [ ] publish API
- [ ] work API

### M4 — Invoice Domain Rebuild

- [ ] pay-address derivation
- [ ] payment matching on new runtime path
- [ ] lifecycle rules
- [ ] sweep pipeline

### M5 — Delivery Surfaces

- [ ] global event polling
- [ ] persisted webhook retries
- [ ] WebSocket subscriptions

### M6 — SDK and Examples

- [ ] SDK aligned to rebuilt runtime
- [ ] examples rebuilt against v2 runtime

### M7 — Hardening

- [ ] restart recovery
- [ ] integration tests
- [ ] security review
- [ ] container and deployment docs
