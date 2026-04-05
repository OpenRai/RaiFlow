Use Changesets for published packages in this workspace.

Typical flow:

1. Create a changeset with `pnpm changeset`
2. Merge to `main`
3. GitHub Actions opens or updates the release PR
4. Merging that PR publishes changed public packages via npm Trusted Publisher

Published packages currently managed this way:

- `@openrai/model`
- `@openrai/webhook`
- `@openrai/raiflow-sdk`

Local development stays on `workspace:*` links so examples and packages continue to use in-repo sources without requiring prereleases.
