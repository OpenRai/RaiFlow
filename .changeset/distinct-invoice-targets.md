---
'@openrai/model': major
'@openrai/raiflow-sdk': minor
---

Allocate a distinct persisted payment destination for every invoice that omits
`invoiceKey`. Explicit `invoiceKey` values continue to identify reusable invoice
destinations within an application account. Remove the obsolete hash-based
invoice derivation helper; indices now come from the persisted invoice allocator.
