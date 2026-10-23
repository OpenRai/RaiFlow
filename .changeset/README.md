Use Changesets for published packages in this workspace.

The published workspace packages release in lockstep. One release version applies to all
published `@openrai/*` packages in this repo:

- `@openrai/model`
- `@openrai/webhook`
- `@openrai/raiflow-sdk`

This does not affect `@openrai/nano-core`, which lives in a separate repo and version line.

Typical flow:

1. Create a changeset with `pnpm changeset`
2. Push the changeset to `main`
3. The Release workflow builds and tests, applies versions, publishes through npm Trusted Publisher, then pushes the version commit and package tags directly to `main`

Each release commit should therefore produce matching package tags for all three published packages at the same version.

`pnpm release:version` remains available as a manual escape hatch when the automated workflow is unavailable.

Local development stays on `workspace:*` links so examples and packages continue to use in-repo sources without requiring prereleases.
