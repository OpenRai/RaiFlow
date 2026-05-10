Ship the current changes to production. Follow these steps in order:

1. Review uncommitted changes (`git status`, `git diff`)
2. Stage and commit in logical phases — group related files, write clear commit messages
3. After each phase: `pnpm build && pnpm test` — fix failures before proceeding
4. When all changes are committed and tests pass:
   - If changes affect published packages (@openrai/model, @openrai/webhook, @openrai/raiflow-sdk): run `pnpm changeset` to create a changeset, then `pnpm release:version`
   - If changes are internal-only (test refactors, docs, config): skip changeset
5. Push: `git push && git push --tags`
6. Wait for GitHub Actions CI to pass on the pushed commit. Check with `gh run list --limit 3`. If any workflow fails, investigate and fix.
7. Confirm the release is complete and all workflows are green.
