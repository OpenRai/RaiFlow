Use Changesets for published packages in this workspace.

The published workspace packages release in lockstep. One release version applies to all
published `@openrai/*` packages in this repo:

- `@openrai/model`
- `@openrai/webhook`
- `@openrai/raiflow-sdk`

This does not affect `@openrai/nano-core`, which lives in a separate repo and version line.

Typical flow:

1. Create a changeset with `pnpm changeset`
2. Apply version bumps, create a commit, and create package tags with `pnpm release:version`
3. Push the commit and tags with `git push && git push --tags`
4. GitHub Actions publishes the tagged public packages via npm Trusted Publisher

Each release commit should therefore produce matching package tags for all three published packages at the same version.

Local development stays on `workspace:*` links so examples and packages continue to use in-repo sources without requiring prereleases.
