# Upgrading and Data Migrations

This package is a Convex component. Its tables are owned by the component, not by
the host app. That has one important consequence:

- Convex enforces schema compatibility with existing stored data.
- The component author is responsible for shipping any migration path needed for
  component-owned tables.
- The host app is responsible for updating the package, deploying it, and
  running the documented upgrade steps.

## Semver policy

Use the package version to signal upgrade risk:

- `patch`: bug fixes, docs, internal refactors, or behavior changes that do not
  require host app changes and do not require rewriting stored component data.
- `minor`: backwards-compatible additions such as new tables, new indexes, new
  optional fields, widened unions, or new public functions.
- `major`: any change that can break existing app code or existing stored data.
  Examples: removing or renaming fields, making an optional field required,
  narrowing a field type, splitting/merging tables, removing public functions,
  or changing data invariants in a way that requires rewriting old rows.

In practice, yes: changes like new optional fields or new tables should usually
be `minor`, not `major`.

## What Convex does, and does not do

Convex will validate a pushed schema against the data already stored in the
deployment. If old data no longer matches the new schema, the deploy fails.

Convex does not automatically:

- rename fields
- move rows between tables
- rewrite documents to a new shape
- infer how users should upgrade stored component data

## Policy for storage-breaking releases

If a release requires rewriting existing component data, do not publish a
version that assumes the migration has already happened.

Instead, ship a compatibility-first upgrade path:

1. Release a version that can deploy against the previous stored data.
2. In that version, make the schema and code tolerant of both old and new data
   shapes.
3. Expose a migration surface so the host app can trigger the rewrite safely.
4. Run the migration to completion.
5. Only then remove legacy fields or old code paths in a later release.

For example, a field rename is not a direct rename. Treat it as:

1. Add the new field while still accepting the old field.
2. Backfill existing documents.
3. Switch reads and writes to the new field.
4. Remove the old field only in a later cleanup release.

## Recommended migration surface

Because host apps cannot directly rewrite this component's internal tables, this
package should expose upgrade helpers when needed.

Preferred default: use `@convex-dev/migrations` inside the component for any
online migration that touches existing rows. It is a good fit because it is:

- resumable
- idempotent-friendly
- observable
- runnable from the dashboard or CLI

The migration code itself should be implemented by this component. Host apps
should not be expected to hand-write migrations for component-owned tables.

In the normal case, the migration is triggered by the host app's operator after
deploying the compatibility release. In other words:

- `convex-wearables` owns the migration logic
- the host app chooses when to start it and monitors it to completion

When a release needs data migration, expose at least:

- a way to start the migration
- a way to query migration status
- a stable, documented migration name or function to run

Useful optional helpers:

- storage version query
- cancel or retry controls
- post-migration verification query

## Expected user upgrade flow

For releases that require migration, the documented flow should be:

1. Upgrade the npm package.
2. Deploy the compatibility release.
3. Run the component-provided migration entrypoint.
4. Wait until the migration reports completion.
5. Verify the app.
6. If needed, upgrade again to a later cleanup release that removes legacy
   compatibility.

For large tables or long data histories, migrations may create noticeable
background load. They are expected to be online migrations, not downtime
windows, but they can still increase usage and compete with normal traffic.
Document when users should prefer running them during off-peak periods.

## Release checklist for major storage changes

Before shipping a major change that affects stored data:

- keep the new release deployable against data from the previous supported
  version
- document exactly what changed in storage
- document whether user action is required
- expose the migration entrypoint and status query
- make migration functions safe to rerun
- explain the rollback or fallback plan

If an in-place migration would be too risky, prefer a new component instance and
a documented re-sync or cutover path instead of a silent breaking upgrade.
