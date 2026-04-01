# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in RaiFlow, please do **not** open a public GitHub issue.

Report it privately by emailing the maintainers or using GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) feature.

Please include:
- a description of the vulnerability
- steps to reproduce
- potential impact
- any suggested mitigations

We will acknowledge your report within 72 hours and aim to provide a fix or mitigation plan within a reasonable timeframe.

---

## Scope

Security concerns relevant to RaiFlow include:

**Custody and keys**
- Seed exposure or insecure storage
- Key derivation failures or collisions
- Unauthorized signing or block publication

**Authentication and access**
- API key leakage or bypass
- Unauthorized invoice creation or cancellation
- Unauthorized send operations
- Webhook endpoint tampering

**Data integrity**
- Invoice state manipulation
- Payment double-recording or missed payments
- Event delivery tampering or forgery
- Confirmation tracking bypass

**Send safety**
- Double-send from a single idempotency key
- Insufficient balance protection
- Frontier race conditions during concurrent sends

**RPC and connectivity**
- Node impersonation / MITM on RPC
- WebSocket subscription injection
- Confirmation feed manipulation

---

## Out of scope

- Vulnerabilities in the underlying Nano protocol or node software
- Issues in third-party dependencies (please report those upstream)
- Social engineering or phishing attacks targeting operators
