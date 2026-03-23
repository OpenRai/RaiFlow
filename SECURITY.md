# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in RaiFlow, please do **not** open a public GitHub issue.

Instead, report it privately by emailing the maintainers or using GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) feature.

Please include:
- a description of the vulnerability
- steps to reproduce
- potential impact
- any suggested mitigations

We will acknowledge your report within 72 hours and aim to provide a fix or mitigation plan within a reasonable timeframe.

## Scope

Security concerns relevant to RaiFlow include:
- webhook signature verification bypass
- payment proof forgery
- invoice state manipulation
- event delivery tampering
- any issue affecting the correctness of payment confirmation logic

## Out of scope

- Vulnerabilities in the underlying Nano protocol or node software
- Issues in third-party dependencies (please report those upstream)
