---
'@openrai/raiflow-sdk': major
---

Remove the obsolete `subaccounts.allocate()` and `receives.batch()` resources
and their runtime routes. Account allocation matrices, manual receive batching,
and deferred watcher activation were introduced for Nanosweeper's game model.
Use accounts and invoices for payment destinations; receiving remains runtime
housekeeping. No compatibility aliases are provided.
