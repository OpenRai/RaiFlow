# Customer Deposit and Withdrawal Example

This Express and HTMX example creates a managed account for a stable customer
reference, shows confirmed deposits, and queues custodial withdrawals. It uses
only `@openrai/raiflow-sdk`; account keys, signing, receiving, and work stay in
the RaiFlow runtime.

Set `RAIFLOW_URL` and `RAIFLOW_API_KEY`, then run:

```bash
cd examples/htmx-wallet
pnpm install
pnpm start
```

Open `http://localhost:3000`. Submitting the same customer reference returns the
same managed account. A withdrawal request carries a stable request reference;
RaiFlow rejects reuse of that idempotency key with a different destination or
amount. The example consumes the persisted global event sequence and saves its
cursor under `.raiflow/event-cursors.json`, then lists account deposit and send
records through their SDK resources.

All values are examples. Do not send real funds to an account unless the
operator has explicitly configured and funded the RaiFlow runtime for that use.
