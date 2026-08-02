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

## Version 0.10.0: workout enrichment and Garmin FIT files

This is a backwards-compatible minor release. It adds `workoutSegments`,
`workoutZones`, and `garminActivityFileJobs`, plus a `by_source_time` index on
`dataPoints`. Existing events and time-series rows remain valid; consumers do
not run a data migration.

After updating the package, deploy the Convex backend so the additive component
schema and functions are installed. Existing workout reads continue unchanged,
and older workouts return empty enrichment arrays.

Garmin Activity File processing is opt-in:

```ts
registerRoutes(http, components.wearables, {
  garmin: {
    activityFiles: { enabled: true },
  },
});
```

Before enabling it, activate Activity Files for the Garmin application and
confirm the callback hostname. If Garmin uses a host outside the built-in
`apis.garmin.com` and `connectapi.garmin.com` allowlist, add that exact hostname
through `allowedHosts`. Do not use wildcards. Raw FIT bytes are not retained.

No historical enrichment is automatic. Existing workouts remain summary-only
until Garmin delivers a new Activity File notification or the consumer
explicitly requests a supported Garmin backfill. Time-series rows derived from
`activityDetails` and FIT follow the consumer's existing storage policy.

## Synthetic provider

The proposed release after `0.4.0` is `0.5.0`. It adds `"synthetic"` to
`ProviderName`, a `components.wearables.synthetic` namespace, and matching
`WearablesClient` helpers. Existing stored rows remain valid and no migration is
required.

Synthetic generation is disabled in `WearablesClient` until userland configures
`providers.synthetic: { enabled: true }`. Do not enable it in production host
configuration. Generated data is stored under its own provider, so it coexists
with real Garmin, Whoop, and other integrations without ownership markers or
takeover behavior.

Generation accepts an optional `asOf` timestamp, rejects ranges ending after
that local day, and does not write later events or time-series points. Hosts can
use the `sedentary` profile to exercise partial-score UI states.

Version `0.6.0` adds the optional `showcase` profile. It creates seeded
calendar weeks with four perfect target days, two days scoring from 80 through
90, and one day below 70. Existing profiles and stored data are unchanged.

## Version 0.7.0: pull lookback and provider correctness

Version `0.7.0` adds optional trailing lookback for pull syncs,
structured provider API failures, stricter connection lifecycle handling, and
Garmin payload compatibility fixes.

Migration assessment:

- No component schema changes are required.
- No stored component documents need rewriting.
- Existing hosts can update and deploy without running a migration.
- Pull lookback is disabled by default. Hosts opt in with
  `pullSyncLookbackHours` on `WearablesClient` or `lookbackHours` per sync call.
- Definitive 400/401 refresh-token rejection now marks the existing connection
  `revoked`; transient 429/5xx/network failures do not revoke it.
- Expired connections without a refresh token are marked `expired`.
- Garmin blood pressure now accepts `measurementTimeInSeconds`; respiration
  samples now prefer `timeOffsetEpochToBreaths` while retaining legacy aliases.

Strava hosts have one required security configuration change if they mount the
exported `stravaWebhookVerify` handler: configure
`STRAVA_WEBHOOK_VERIFY_TOKEN` in the Convex deployment. The route now fails
closed when the variable is absent.

Recommended release classification: minor while the package is pre-1.0 because
it adds public sync configuration. There is no data migration.

## Version 0.8.0: durable provider and user deletion

Version `0.8.0` replaces the large-account deletion path with explicit,
Workflow-backed lifecycle APIs. It also supports optional provider-side
deregistration for Garmin, Strava, Polar, and WHOOP.

Migration assessment:

- The component schema adds `dataDeletionOperations` and indexes for operation
  lookup, OAuth state cleanup, and provider attribution of legacy summaries.
- Existing documents need no rewrite.
- Hosts must deploy the component schema before calling the new APIs.
- `disconnect` remains local and non-destructive.
- Provider deregistration is opt-in and disabled by default on deletion calls.
- `deleteAllUserData` remains available but is deprecated because its
  synchronous execution can exceed Convex limits for large accounts.

Recommended existing-host upgrade:

1. Update the package and deploy the additive schema.
2. Replace `deleteAllUserData` with `startUserDataDeletion`.
3. Store or return the operation ID and observe it with
   `getDataDeletionOperation`.
4. Treat `completed` and `completed_with_warnings` as successful local
   deletion outcomes according to the host product's policy.
5. Retry `failed` operations or explicitly cancel them. Failed operations keep
   their ingestion fence to prevent partially deleted data from returning.
6. Remove terminal operation and Workflow history with
   `cleanupDataDeletionOperation` after the result is no longer needed.

Provider-scoped deletion preserves other provider data. Whole-user deletion
also removes Synthetic data, user retention-policy assignments, and earlier
deletion-operation records. Deployment-wide provider credentials and global
storage-policy configuration are preserved.

Recommended release classification: minor. All APIs and schema changes are
additive, and existing connection/disconnect behavior remains compatible.

## Version 0.9.0: resilient SDK ingestion

Version `0.9.0` adds an opt-in v2 ingestion action and HTTP route for normalized
Apple Health, Health Connect, and Samsung Health payloads. V2 validates rows
independently, stores valid rows in partial mode, and returns bounded rejection
details without echoing health values.

Migration assessment:

- No component schema changes or stored-row rewrites are required.
- The existing `ingestNormalizedPayload` action and `/sdk/sync` route retain
  their strict, all-or-nothing behavior.
- When SDK routes are enabled, the v2 route defaults to `/sdk/sync/v2`. Set
  `syncV2Path: false` to disable it or provide a custom path.
- Existing clients can upgrade without changing requests. Adopt v2 per SDK
  client when it can handle `accepted`, `partially_accepted`, and `rejected`
  reports.
- V2 requires a stable `requestId`; retries are safe because accepted events,
  points, and summaries use the component's existing idempotent upsert keys.
- `partial` is the default. Use `strict` when no rows should persist if any row
  is invalid.

Recommended rollout:

1. Update the package and deploy component code; no migration command is needed.
2. Keep v1 clients unchanged.
3. Update one client to post the v2 envelope and interpret rejection codes.
4. Monitor recurring producer validation errors.
5. Expand v2 adoption independently across clients.

## Provider-aware daily summaries

The provider-aware daily summaries release adds provider provenance to
`dailySummaries` so native Apple Health, Google Health Connect, Garmin, and
other provider summaries can coexist for the same user, date, and category.

This is a migration-safe minor release:

- Existing `dailySummaries` rows remain readable because the stored `provider`
  field is optional at the schema layer.
- New summary writes require `provider` and are keyed by user, provider,
  category, and date.
- Provider-filtered reads only return rows that already have that provider. They
  do not infer a provider for legacy rows.
- No host-run data migration is required for deployment.

Host apps that display canonical daily totals should pass `provider` to
`getDailySummaries` or merge rows using their own source precedence rules.
Unfiltered reads are useful for inspection and custom reconciliation, but they
are provider-mixed storage reads.

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
