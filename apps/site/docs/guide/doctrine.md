# Doctrine

RaiFlow begins with the smallest useful payment runtime for Nano.

## Core rules

1. **Observe first**  
   Keyless incoming payment detection before wallet operation.

2. **Confirmed payment first**  
   Confirmed matching Nano transfers become stable application objects.

3. **Events first**  
   Applications should consume normalized events, not raw block mechanics.

4. **Off-chain metadata**  
   Orders, users, and usage context remain application concerns.

5. **Idempotency everywhere**  
   Retries and partial failure are normal, not exceptional.

6. **Tiny public API**  
   Start with `Invoice`, `Payment`, `EventEnvelope`, and `WebhookEndpoint`.

7. **Custody later**  
   Payouts, refunds, and treasury movement are a later operating mode.
