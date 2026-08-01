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

## Release expectations

Classify public changes with semantic versioning:

- patch: backward-compatible fixes with no new public capability;
- minor: backward-compatible APIs, providers, or additive schema capabilities;
- major: breaking API, behavior, configuration, or migration requirements.

Before publishing, run lint, type checking, tests, build, and a package dry run.
Document public behavior and upgrade requirements in the package README,
`UPGRADING.md`, and the Fumadocs site as appropriate.
