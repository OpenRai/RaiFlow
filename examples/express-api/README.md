# Watched Payment Example

This Express example watches an external Nano address. RaiFlow stores confirmed
deposit records and account events; the application never handles private keys,
proof of work, frontiers, receive blocks, or watcher configuration.

Set `RAIFLOW_URL` and `RAIFLOW_API_KEY`, then run:

```bash
cd examples/express-api
pnpm install
pnpm start
```

Open `http://localhost:3002` and submit an address. Creating the watched
account uses `watch-address:<address>` as its idempotency key, so retrying the
same request resolves the same runtime account. The event panel reads the
persisted global sequence and saves the last handled sequence in browser storage;
after a refresh or connection loss it resumes with the `after` cursor. Deposit
history includes the runtime's matching disposition when an incoming transfer
also matched an invoice.
