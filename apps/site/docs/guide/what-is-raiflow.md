# What is RaiFlow?

RaiFlow is a Nano payment runtime built by OpenRai.

It turns low-level node RPC and block-lattice mechanics into a simpler application-facing model for:
- payment expectations
- confirmed payment proofs
- events
- webhooks

The first version of RaiFlow is intentionally narrow.

It should let a developer:
1. create an invoice
2. detect an incoming payment
3. confirm and normalize that payment
4. receive a reliable event
5. join payment state to off-chain business context

RaiFlow begins in observe mode.  
Custody comes later, if it is needed.
