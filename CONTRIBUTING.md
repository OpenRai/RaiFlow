# Contributing to RaiFlow

Thank you for your interest in contributing to RaiFlow.

RaiFlow is being built in public under the OpenRai umbrella. Contributions of all kinds are welcome — from bug reports and documentation improvements to RFCs, examples, and core implementation work.

---

## Ways to contribute

- **Open issues** — report bugs, ask questions, suggest improvements
- **Propose RFCs** — use the RFC template to propose design changes or new features
- **Write examples** — help demonstrate how RaiFlow can be used in real applications
- **Test and review** — test example integrations, review open PRs
- **Challenge assumptions** — point out concrete use cases where our current design falls short

---

## Development setup

This is a pnpm monorepo. You will need:

- [Node.js](https://nodejs.org/) v20+
- [pnpm](https://pnpm.io/) v10+

```bash
# Install dependencies
pnpm install

# Run the docs site locally
pnpm site:dev

# Build all packages
pnpm build

# Run all tests
pnpm test
```

---

## RFC process

For significant design decisions, open an RFC by:

1. copying the RFC template from `rfcs/`
2. creating a new file `rfcs/XXXX-your-title.md`
3. opening a pull request for discussion

RFCs are lightweight — they exist to freeze decisions and record alternatives considered, not to create bureaucracy.

---

## Code of conduct

All contributors are expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## License

By contributing to RaiFlow, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
