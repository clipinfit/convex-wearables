# Contributing to Convex Wearables

## Project boundary

`convex-wearables` is an independent open-source component. Its responsibilities
are to:

- evolve its provider-neutral public API and architecture;
- release changes with semantic versioning;
- maintain comprehensive automated tests; and
- provide high-quality package, reference, and migration documentation.

Consumer applications—including applications maintained by this project's core
maintainers—are integration examples and compatibility signals. Their product
roadmaps, privacy policies, deployment schedules, and adoption work are outside
the component's delivery scope and must not constrain otherwise sound component
development.

Upgrade guidance should be written for generic consumers. A consumer-specific
migration may be maintained in that consumer's own repository, but it is not a
component release requirement.

## Workspace

This repository uses npm workspaces:

- `packages/convex-wearables` is the publishable npm package;
- `apps/web` is the Fumadocs documentation site; and
- `docs` contains project plans and design documents that are not published in
  the npm package.

Run `npm install` and the root `build`, `lint`, `typecheck`, and `test` scripts
to check the whole workspace. Use `npm run dev:web` to run the documentation
site. Package-only commands can be run with
`npm run <script> --workspace @clipin/convex-wearables`.

## Release expectations

Classify public changes with semantic versioning:

- patch: backward-compatible fixes with no new public capability;
- minor: backward-compatible APIs, providers, or additive schema capabilities;
- major: breaking API, behavior, configuration, or migration requirements.

Before publishing, run lint, type checking, tests, build, and a package dry run.
Document public behavior and upgrade requirements in the package README,
`UPGRADING.md`, and the Fumadocs site as appropriate.

Publish from the package workspace with `npm run release -- <patch|minor|major>`
or run npm's publish command with
`--workspace @clipin/convex-wearables`. Moving the package within this GitHub
repository does not change its npm identity. If the public Convex Components
Directory entry needs a new source, documentation, or demo URL, request that
metadata update from the submission page on your Convex profile.
