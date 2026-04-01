# Contributing to RaiFlow

Thank you for your interest in contributing to RaiFlow.

RaiFlow is built in public under the OpenRai umbrella. Contributions of all kinds are welcome — bug reports, documentation improvements, RFCs, examples, and core implementation work.

---

## Ways to contribute

- **Open issues** — report bugs, ask questions, suggest improvements
- **Propose RFCs** — use the RFC format to propose design changes or new capabilities
- **Write examples** — demonstrate RaiFlow in real application contexts
- **Test and review** — test integrations, review open PRs, challenge assumptions
- **Help with implementation** — see [`docs/progress.md`](./docs/progress.md) for the current frontier

---

## Development setup

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Run docs site locally
pnpm site:dev
```

Requirements:
- Node.js v20+
- pnpm v10+

---

## Architecture decisions

RaiFlow uses lightweight RFCs for durable design decisions.

RFCs exist to:
- define terms
- record alternatives considered
- explain why a design was chosen
- freeze decisions so they are not re-litigated in every PR

When proposing a significant change:
1. Check existing RFCs first — the decision may already be made
2. Copy the RFC format for a new proposal if needed
3. Open a PR or issue for discussion

RFCs are short and opinionated. They are not project management documents.

---

## Doc authority model

RaiFlow uses four layers, each with one job:

| Document | Job |
|---|---|
| `README.md` | current project identity and quickstart |
| `ROADMAP.md` | long-horizon milestone map |
| `docs/progress.md` | current execution frontier |
| `rfcs/*.md` | architecture decisions and tradeoffs |

Architectural review docs (`docs/architectural-review*.md`) are implementation notes, not authoritative references.

---

## Code of conduct

All contributors are expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## License

By contributing to RaiFlow, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
