# RFC 0001 — Project Framing

**Status:** Draft  
**Created:** 2024  
**Authors:** OpenRai contributors

---

## Summary

This RFC establishes the foundational framing for the RaiFlow project: what it is, what it is not, and what it will build first.

---

## Motivation

Nano has strong settlement properties: feeless transfer, fast finality, permissionless access, and no mining overhead.

Despite this, developers who want to accept Nano in real applications face a significant integration gap. The tools available today require direct interaction with low-level node RPC, manual block/account monitoring, custom confirmation tracking, ad-hoc payment matching, and bespoke webhook or event delivery logic.

This integration friction prevents Nano from being used in many application contexts where it would otherwise be an excellent fit: micropayments, pay-per-use APIs, usage-based billing, agent-to-agent payments, and machine-scale commerce.

RaiFlow exists to close this gap.

---

## Design

### What RaiFlow is

RaiFlow is an application-facing payment runtime for Nano.

It abstracts node RPC and block-lattice mechanics to expose a simpler integration surface:

- create payment expectations (invoices)
- detect and normalize incoming payments
- produce confirmed payment proofs
- emit reliable application events and webhooks
- join off-chain business metadata to payment state

### What RaiFlow is not

RaiFlow is not:

- a Nano protocol fork or modification
- a consensus-layer change
- a new base ledger or token
- a generalized wallet product
- a custodial treasury platform (initially)
- an exchange integration
- a rebrand of Nano

### First operating mode: observe

The first version of RaiFlow operates in **observe mode**: it watches Nano accounts for incoming payments, matches them to expectations, and emits events. It does not hold or spend funds.

This is intentional. RaiFlow should prove its value as a payment runtime before it operates as a custodial system.

### Core primitives

The initial public API surface is:

- `Invoice` — a payment expectation with associated metadata
- `PaymentProof` — a confirmed incoming payment, normalized into a stable application object
- `Event` — a normalized application event (e.g. `payment.confirmed`)
- `WebhookEndpoint` — a registered delivery target for events

### Initial event vocabulary

- `invoice.created`
- `payment.detected`
- `payment.confirmed`
- `invoice.completed`
- `invoice.expired`
- `webhook.delivery_failed`

---

## Alternatives considered

### Build a full custodial wallet first
Rejected. Custody increases complexity and risk substantially. Starting with observation allows RaiFlow to prove its core value — normalizing and routing payment events — without the liability of holding funds.

### Build on top of an existing payment gateway abstraction
Rejected. Nano's block-lattice model is different enough from account-balance models that a generic abstraction would either leak too much complexity or hide too much of what makes Nano useful.

### Target only one framework or language
Rejected. The core runtime should be framework-neutral. SDK packages can provide framework-specific conveniences.

---

## Open questions

- What persistence adapter(s) should the runtime support first?
- Should invoice IDs be opaque or structured?
- What confirmation threshold should the observe-mode use by default?
