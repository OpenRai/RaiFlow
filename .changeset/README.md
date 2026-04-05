Use Changesets for published packages in this workspace.

Typical flow:

1. Create a changeset with `pnpm changeset`
2. Apply version bumps, create a commit, and create package tags with `pnpm release:version`
3. Push the commit and tags with `git push && git push --tags`
4. GitHub Actions publishes the tagged public packages via npm Trusted Publisher

Published packages currently managed this way:

- `@openrai/model`
- `@openrai/webhook`
- `@openrai/raiflow-sdk`

Local development stays on `workspace:*` links so examples and packages continue to use in-repo sources without requiring prereleases.
