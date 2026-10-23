---
'@openrai/raiflow-sdk': major
---

Align invoice creation across the SDK and HTTP runtime. Callers must provide
exactly one amount representation: a raw integer string or a decimal XNO string.
Decimal strings convert through nano-core's `NanoAmount`; numeric JSON amounts,
out-of-range values, unsupported completion policies, and non-string metadata
values are rejected as structured bad requests.
