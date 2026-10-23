---
'@openrai/model': minor
'@openrai/raiflow-sdk': minor
---

Expose a durable disposition for each confirmed deposit and emit
`deposit.observed` events. Late and unmatched funds remain queryable without
being credited to another invoice.
