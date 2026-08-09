---
date: 2026-08-01
status: DEFERRED
priority: P3
semver: minor
owner_repo: convex-wearables
activation: explicit-preview-and-confirmation
---

# Semantic Event Retention Policy PRD

> **Component-only, low-priority proposal.** This is an optional convenience API,
> not a prerequisite for other roadmap work. A consumer can already implement
> periodic historical-event cleanup with its own scheduled functions and
> component-facing deletion wrappers. The component should implement this only
> if repeated consumer demand shows that a shared, ownership-safe policy API is
> more valuable than leaving cleanup orchestration to each consumer.

## Summary

Add an opt-in retention system for semantic records in the `events` table:
workouts and sleep sessions. Consumers may define deployment defaults and
named per-user presets, preview the destructive effect, explicitly activate a
specific policy revision, and let bounded background maintenance delete events
that have exceeded their configured lifetime.

This policy is intentionally independent from the existing time-series storage
policy:

| Policy | Owns | Can compact? | Deletes |
|---|---|---:|---|
| Time-series storage policy | `dataPoints`, `timeSeriesRollups`, and time-series maintenance state | yes | raw samples and rollup buckets |
| Semantic event retention | `events` and event-owned detail children | no | workout/sleep records, workout segments, and workout zones |

Activating one policy must not activate, alter, or infer configuration for the
other. Matching preset names are only a host convention. Event retention must
not delete `dataPoints`, `timeSeriesRollups`, `dailySummaries`, or time-series
policy state.

The built-in and upgrade default is retain forever. Installing or deploying
the release must never delete an existing event.

This proposal is intentionally low priority. It standardizes a potentially
useful lifecycle operation, but it does not unlock ingestion, provider support,
or normalized data fidelity. Consumer-managed cleanup remains a legitimate and
supported architectural choice.

## Existing Lifecycle Principles and Deliberate Extension

The component's existing storage policy applies only to time-series rows:

- `archive_after_days` optionally aggregates old live samples into daily
  archive rows;
- `delete_after_days` optionally deletes old live or archived samples;
- `None` disables each destructive threshold;
- archival and deletion settings are independent;
- work is bounded by row and wall-clock limits; and
- unfinished cleanup continues during a later scheduled run.

Semantic event retention should follow the same safety principles:

- destructive behavior is disabled until explicitly configured;
- record age is based on the health record timestamp, not insertion time;
- cleanup is bounded and resumable;
- ownership is verified before deletion;
- parent-owned detail records are deleted with their parent; and
- time-series and semantic lifecycle domains remain separate.

This PRD deliberately extends lifecycle controls from dense time-series data to
semantic workout and sleep records while keeping the two policy domains
independent.

## Problem

The component already controls the lifetime and resolution of dense metric
samples. Workouts and sleep sessions are different semantic records and remain
indefinitely today unless:

- a provider sends an explicit delete notification;
- the host starts provider/user lifecycle deletion; or
- custom host code performs cleanup.

Retain-forever is a safe default, but not every deployment can or should keep
all semantic health history forever. Consumers may need shorter storage for
privacy, cost, contractual, or product reasons. Requiring every consumer to
write its own deletion scheduler creates inconsistent ownership checks,
orphaned workout details, unbounded mutations, and accidental coupling to
time-series retention.

## Product Outcomes

A consumer can safely express policies such as:

- keep all workouts and sleep forever;
- keep workouts for 90 days and sleep for one year;
- keep Polar events for 180 days but Garmin events forever; or
- assign a named `short`, `standard`, or `extended` preset to individual users.

Before deletion begins, the consumer can preview how many records are already
eligible and must confirm the exact immutable policy revision. After activation,
newly ingested events outside the effective retention window do not become
durably visible, and existing expired records are removed in bounded batches.

These outcomes are convenience and consistency benefits, not capabilities that
only the component can provide. A host with simpler requirements may schedule
its own bounded cleanup and never adopt this API.

## Goals

- Configure semantic event retention independently from time-series retention.
- Support deployment-wide rules and named per-user presets.
- Scope v1 rules by provider and/or event category.
- Keep retain forever as the built-in default.
- Require preview and explicit revision-confirmed activation before the first
  destructive run.
- Evaluate age from `events.startDatetime`.
- Prevent repeated syncs from resurrecting already expired events.
- Delete event-owned child records with the event.
- Preserve unrelated time-series samples, rollups, summaries, sources, and
  connections.
- Process deletion in bounded, restart-safe maintenance steps.
- Expose focused configuration, preview, progress, and failure status.
- Integrate safely with provider/user deletion and concurrent ingestion.
- Document irreversibility and recovery options clearly.

## Non-Goals

- Do not compact semantic events into aggregate rows.
- Do not modify or reuse time-series policy rules or assignments.
- Do not delete `dataPoints` or `timeSeriesRollups`, including samples derived
  from a workout activity file.
- Do not delete `dailySummaries`.
- Do not delete `dataSources`, provider connections, OAuth state, or provider
  settings.
- Do not retain or hide expired events in queries as an entitlement mechanism;
  this feature physically deletes them.
- Do not provide legal or regulatory retention defaults.
- Do not infer a finite policy from subscription names or application plans.
- Do not support arbitrary event `type` matching in v1.
- Do not archive full events to another component table before deletion.
- Do not make a finite policy active merely because configuration was written.

## Terminology

- **Event:** a row in `events`, currently a workout or sleep session.
- **Occurrence time:** `events.startDatetime`, representing when the event
  began.
- **Retention window:** duration after occurrence time during which an event is
  retained.
- **Forever:** no age-based deletion; represented by `retainFor: null`.
- **Draft revision:** validated policy configuration that cannot delete data.
- **Active revision:** immutable revision used by ingestion and maintenance.
- **Preview:** bounded/counting analysis of what an activation would delete.
- **Owned child:** a record whose lifecycle has no meaning without its event,
  currently `workoutSegments` and `workoutZones`.

## Scope Boundaries

### Deleted with an expired event

- the `events` row;
- embedded sleep stages, because they are part of the row;
- all `workoutSegments` referencing the event;
- all `workoutZones` referencing the event; and
- any still-present `garminActivityFileJobs` that reference the event's
  external ID.

Future event-owned tables must be added to one central cascade helper and its
tests before release. A parent must never be deleted while known owned children
remain.

### Explicitly not deleted

- `dataPoints`;
- `timeSeriesRollups`;
- `timeSeriesSeriesState`;
- all time-series rules, assignments, and settings;
- `dailySummaries`;
- `dataSources`;
- `connections`;
- other users' events or children; and
- unrelated webhook, sync, backfill, or deletion operation history.

This boundary holds even when a time-series point was extracted from the same
FIT file or provider activity as the expired event. Consumers that want aligned
sample and event lifetimes configure both policies independently.

## Policy Model

### V1 rule input

```ts
type EventRetentionRuleInput = {
  provider?: ProviderName;
  category?: "workout" | "sleep";
  retainFor: string | number | null;
};
```

- String durations use the same parser and units as the time-series policy.
- Numeric durations are milliseconds.
- `null` means retain forever.
- Finite values must be positive and meet a documented minimum, recommended
  one day, to prevent accidental near-immediate deletion.
- Duplicate scopes in the same rule set are rejected.
- Unknown providers/categories and malformed durations fail validation.
- An empty draft is rejected; use an explicit global forever rule when that is
  intended.

Event `type` is deferred from v1. The current index can bound work efficiently
by data source, category, and occurrence time. Arbitrary type matching would
either require a new index/denormalization or repeatedly scan nonmatching old
rows. Provider/category rules cover the strong initial use cases without that
cost.

### Example configuration

```ts
const draft = await wearables.createEventRetentionPolicyDraft(ctx, {
  defaultRules: [
    { retainFor: null },
    { category: "workout", retainFor: "365d" },
    { provider: "polar", category: "workout", retainFor: "180d" },
  ],
  presets: [
    {
      key: "short",
      rules: [
        { category: "workout", retainFor: "30d" },
        { category: "sleep", retainFor: "90d" },
      ],
    },
    {
      key: "extended",
      rules: [{ retainFor: null }],
    },
  ],
});

const preview = await wearables.previewEventRetentionPolicy(ctx, {
  revisionId: draft.revisionId,
});

await wearables.activateEventRetentionPolicy(ctx, {
  revisionId: draft.revisionId,
  previewToken: preview.previewToken,
  confirmation: "DELETE_EXPIRED_EVENTS",
});
```

The exact wrapper syntax may follow package conventions, but draft, preview,
and activation must remain separate operations.

## Rule Resolution

Resolve one retention window for a `(userId, provider, category)` tuple. The
first matching rule wins:

1. assigned preset: provider + category;
2. assigned preset: provider;
3. assigned preset: category;
4. assigned preset: global;
5. active deployment default: provider + category;
6. active deployment default: provider;
7. active deployment default: category;
8. active deployment default: global;
9. built-in fallback: retain forever.

A preset need not repeat deployment defaults. If no preset rule matches, rule
resolution falls through to active deployment defaults.

Assignments are event-policy assignments only. Assigning preset key `standard`
here does not assign or change a time-series preset with the same name.

## Timestamp Semantics

Retention uses `startDatetime`, not Convex `_creationTime`.

```text
expired when startDatetime < evaluationTime - retainForMs
```

Use strict `<`, so an event exactly on the cutoff is retained until a later
evaluation. Compute `evaluationTime` once per maintenance batch or preview page
to avoid boundary drift inside a transaction.

Consequences:

- historical events can be immediately eligible when a finite policy activates;
- late provider delivery cannot extend an old event's lifetime;
- updating or re-enriching an event does not reset its age; and
- clock-invalid events must not be silently deleted.

Reject newly ingested events with invalid/nonfinite timestamps through existing
validation. If legacy data has an impossible timestamp outside documented
bounds, preview reports it separately and maintenance skips it until corrected.

## Data Model

### `eventRetentionPolicyRevisions`

```ts
{
  revisionId: string;
  status: "draft" | "active" | "superseded" | "canceled";
  configurationHash: string;
  createdAt: number;
  activatedAt?: number;
  supersededAt?: number;
}
```

Exactly one revision may be active. Revisions are immutable after creation.
Editing creates a new draft and new hash.

### `eventRetentionPolicyRules`

```ts
{
  revisionId: string;
  setKind: "default" | "preset";
  presetKey?: string;
  provider?: ProviderName;
  category?: "workout" | "sleep";
  retainForMs?: number; // absent means forever
  specificity: number;
}
```

Indexes support revision/set lookup and scope uniqueness by convention.

### `eventRetentionPolicyAssignments`

```ts
{
  userId: string;
  presetKey: string;
  assignedAt: number;
}
```

Assignments refer to a preset key rather than revision-specific rule IDs so a
new active revision can redefine a preset deliberately. Activation preview must
include how many assigned users would be affected by changed or removed preset
definitions. A missing preset falls back to deployment defaults and is surfaced
as a configuration warning.

### `eventRetentionSettings`

```ts
{
  key: "global";
  activeRevisionId?: string;
  maintenanceEnabled: boolean;
  maintenanceIntervalMs: number;
  nextMaintenanceAt?: number;
  scheduledAt?: number;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastDeletedEvents?: number;
  lastDeletedChildren?: number;
  lastErrorCode?: string;
}
```

No active revision means built-in retain forever. Maintenance may be enabled
operationally, but without an active finite rule it performs no deletions and
should avoid scheduling repeated no-op work.

### `eventRetentionState`

```ts
{
  dataSourceId: Id<"dataSources">;
  userId: string;
  provider: ProviderName;
  category: "workout" | "sleep";
  evaluatedRevisionId: string;
  nextMaintenanceAt: number;
  lastMaintenanceAt?: number;
  lastDeletedStartDatetime?: number;
  lastErrorCode?: string;
}
```

Process per data source and category because the existing
`events.by_source_category_time` index can read the oldest eligible rows
without denormalizing provider onto every event or rewriting existing rows.
Provider comes from `dataSources` when state is initialized.

Required indexes:

- revision/rules lookup;
- assignment by user and by preset;
- settings singleton key;
- state by `(dataSourceId, category)`; and
- state by `nextMaintenanceAt`.

No new index on the existing `events` table is required for v1.

## Draft, Preview, and Activation Safety

### Writing a draft is non-destructive

Creating a draft validates and stores configuration but does not affect reads,
ingestion, or maintenance. Multiple drafts may exist; only an explicitly
activated revision is effective.

### Preview is mandatory for finite policies

Preview reports, at minimum:

- revision ID and configuration hash;
- evaluation timestamp;
- total eligible events;
- counts by provider and category;
- counts of owned segments/zones/jobs expected to cascade;
- oldest and newest eligible occurrence times;
- number of users with affected preset assignments;
- invalid timestamp rows skipped;
- whether the count is exact or a bounded estimate; and
- whether more preview work remains.

Large previews run in bounded pages and expose progress. They must not fetch or
return health-event payloads.

### Activation is revision-bound

Activation requires:

- the exact draft revision ID;
- a nonexpired preview token bound to the configuration hash;
- a literal destructive confirmation value; and
- a preview completed recently enough, recommended within 24 hours.

If configuration, assignment counts, or the revision changes materially after
preview, activation must require another preview. Assignment changes after
activation do not require global reactivation, but assigning a user to a preset
is itself an explicit host mutation and should return the effective retention
impact.

### Activation does not delete inline

Activation atomically switches the active revision, invalidates old maintenance
state, and schedules bounded maintenance. It never performs a large deletion
inside the activation mutation.

## Ingestion Behavior

Maintenance alone is insufficient because scheduled pulls can repeatedly
reinsert expired history. Every semantic event write path must apply the active
event policy before insertion/upsert:

- manual and scheduled provider pull;
- inbound provider webhooks;
- Garmin push/backfill;
- SDK ingestion;
- Synthetic generation; and
- future file imports.

For each candidate event:

1. resolve provider and category from trusted component context;
2. resolve the active user policy;
3. compare `startDatetime` with one batch evaluation timestamp;
4. store/upsert if retained; or
5. return an internal `skippedByEventRetention` outcome if already expired.

Do not derive provider from untrusted payload text. Do not apply event policy to
data points or daily summaries arriving in the same ingestion request.

Public aggregate ingestion results may add optional skipped counts. Existing
result fields and error semantics remain backward compatible.

When no active finite rule can match, use a fast path that avoids policy reads
per event.

## Bounded Maintenance

### Scheduling

Reuse the proven Convex maintenance principles rather than sharing time-series
policy state:

- one coalesced global wake-up;
- due work discovered through `eventRetentionState.by_next_maintenance`;
- one bounded mutation batch per state item;
- immediate rescheduling while backlog remains;
- normal interval when caught up; and
- no endless scheduler loop when all effective rules retain forever.

Event retention may reuse generic duration, coalescing, and scheduling utility
functions. It must not reuse the time-series rules, assignments, settings rows,
series cursors, or deletion code.

### Batch algorithm

For one `(dataSourceId, category)` state:

1. load active revision and verify state is not stale;
2. load data source and verify user/provider identity;
3. resolve effective rule;
4. if forever, mark state caught up without scanning events;
5. compute the cutoff once;
6. query oldest events before the cutoff using
   `by_source_category_time`;
7. for each selected event, delete owned children and then the parent;
8. update counts/state; and
9. reschedule immediately if a full batch was deleted.

Start with a conservative event batch, recommended 25 events per mutation,
because each workout may have many segment/zone children. Child deletion must
also be bounded. If one event can exceed the mutation budget, represent its
cascade as resumable phases and delete the parent only after all children are
gone.

Never collect all user events or all event children in one mutation.

### Restart and revision safety

- Deletion is idempotent; a missing child or event is a successful no-op.
- Each step re-reads the active revision before deletion.
- If the active revision changes, stale scheduled work stops and state is
  reinitialized under the new revision.
- A longer/forever replacement policy stops future deletions immediately after
  activation, but cannot restore already deleted rows.
- Scheduler duplication is safe because each deletion mutation rechecks row
  existence and policy state.

## Canonical Event Cascade

Create one internal deletion primitive used by:

- event retention;
- provider delete webhooks;
- direct event deletion;
- provider lifecycle deletion where practical; and
- whole-user lifecycle deletion where practical.

Illustrative contract:

```ts
deleteEventCascade({
  eventId,
  expectedUserId,
  expectedDataSourceId,
  reason: "retention" | "provider_delete" | "provider_removal" |
    "user_deletion",
})
```

Before deleting, it verifies:

- the event exists;
- event `userId` equals `expectedUserId`;
- event `dataSourceId` equals the expected source;
- the source belongs to that user; and
- retention callers still have an active matching finite policy.

Cascade order:

1. cancel/delete matching ephemeral Garmin activity-file job state;
2. delete workout segments in bounded pages;
3. delete workout zones in bounded pages;
4. delete any future registered event-owned child tables; and
5. delete the event parent.

This makes ownership validation and the owned-detail cascade explicit for
Convex tables.

## Concurrency and Lifecycle Interaction

### Concurrent event upsert

The storage mutation applies the active policy. If maintenance races an update,
the final transaction serialization must leave either:

- a retained event under the current rule; or
- no expired event and no owned children.

Maintenance rechecks event timestamp and active revision immediately before the
cascade begins.

### Provider or user deletion

Lifecycle deletion takes precedence. Event retention should skip sources/users
with an active deletion fence and allow the lifecycle workflow to remove their
data. Retention state and assignments are removed by whole-user deletion;
provider deletion removes matching state while preserving user-level policy
assignment for other providers.

### Policy changes during maintenance

Activating a new revision changes the singleton active revision atomically.
Every maintenance batch checks it. Old scheduled calls become harmless stale
wake-ups.

### Disconnect without deletion

Disconnected users continue aging under the active policy. Retention is a data
lifecycle rule, not a connection-status rule.

## Query Semantics

Queries remain storage-based and do not hide events merely because they have
crossed a cutoff while maintenance is catching up. This keeps query behavior
simple and transparent: an event exists until physical deletion commits.

The documented guarantee is eventual enforcement, with maintenance status
showing backlog. Do not turn retention into an authorization or plan-display
filter.

## Public API Surface

Suggested generic consumer methods:

```ts
createEventRetentionPolicyDraft(ctx, { defaultRules, presets? })
getEventRetentionPolicyDraft(ctx, { revisionId })
previewEventRetentionPolicy(ctx, { revisionId, cursor? })
activateEventRetentionPolicy(ctx, { revisionId, previewToken, confirmation })
cancelEventRetentionPolicyDraft(ctx, { revisionId })
getEventRetentionPolicyConfiguration(ctx)
getEffectiveEventRetentionPolicy(ctx, { userId, provider, category })
setUserEventRetentionPolicyPreset(ctx, { userId, presetKey })
clearUserEventRetentionPolicyPreset(ctx, { userId })
getEventRetentionMaintenanceStatus(ctx)
runEventRetentionMaintenance(ctx, { maxBatches? })
```

The package owns policy mechanics. The host owns authentication,
authorization, administrative UI, plan mapping, and legal/privacy decisions.
The component must not expose unauthenticated policy-management HTTP routes.

## Configuration Replacement and Policy Downgrades

Any new active configuration is a new revision and follows preview plus
activation if it introduces or shortens a finite window for any existing
scope.

A revision that only lengthens windows or changes scopes to forever is
non-destructive, but using the same revision workflow keeps auditability and
rollback behavior understandable. Its preview may be fast and report zero
eligible deletions.

Assigning a user from a longer preset to a shorter preset can immediately make
history eligible. The assignment API must return:

- previous and new effective windows;
- whether the change is destructive;
- a bounded affected-count preview or token; and
- require explicit confirmation for destructive assignment changes.

Do not silently reinterpret a missing/deleted preset as the shortest policy.
Fall back to deployment defaults and surface a warning.

## Recovery and Rollback

Before activation, rollback is simply canceling the draft.

After activation but before maintenance deletes rows, activating a retain-forever
revision stops future deletion.

After physical deletion, configuration rollback cannot restore data. Recovery
may require:

- provider re-sync, if the provider still exposes the historical record;
- replay from a permitted source export; or
- external backups controlled by the deployment operator.

The component must not claim deleted events are recoverable. Re-sync still
passes through the currently active retention gate.

## Observability

Expose focused lifecycle information:

- active revision and activation time;
- draft revision/hash;
- last preview time and summarized impact;
- maintenance enabled/disabled;
- last start/completion;
- last event/child deletion counts;
- due state count or bounded backlog signal;
- current policy revision being processed; and
- safe error codes without event payloads.

Do not add unbounded per-event audit rows. Operational logs must not include
event health fields. This scoped status does not revive the deferred unified
sync-observability workstream.

## Retention of Retention Metadata

- Active policy configuration remains until superseded.
- Keep a bounded number of superseded revision headers for operator context;
  detailed rules may be removed after a documented period.
- Whole-user deletion removes that user's event-policy assignment and state.
- Preview tokens expire quickly and store only counts/hash metadata.
- Maintenance status is overwritten/compacted rather than accumulated forever.

## Implementation Phases

### Phase A: policy contracts and safe read-only preview

- Add revision, rule, assignment, settings, and state tables.
- Add duration validation and deterministic rule resolution.
- Add draft/configuration/effective-policy queries.
- Add bounded preview with exact/estimated status.
- Keep active revision unset and deletion impossible.

### Phase B: canonical cascade and maintenance

- Consolidate ownership-checked event cascade behavior.
- Include segments, zones, and ephemeral activity-file jobs.
- Add state initialization and bounded maintenance.
- Add stale revision, lifecycle fence, restart, and backlog handling.
- Keep activation unavailable until cascade tests pass.

### Phase C: activation and ingestion gate

- Add preview-bound activation.
- Apply policy across every semantic event ingestion path.
- Add skipped-by-retention counts where useful.
- Add destructive preset-assignment confirmation.
- Verify time-series and summary paths remain untouched.

### Phase D: documentation and release hardening

- Add Fumadocs guides and API reference.
- Add dry-run, activation, monitoring, rollback, and recovery examples.
- Run full tests, typecheck, lint, build, and package dry run.
- Verify a clean upgrade retains all events until explicit activation.

## Migration and Existing Consumer Upgrade Path

Schema impact is additive:

- `eventRetentionPolicyRevisions`;
- `eventRetentionPolicyRules`;
- `eventRetentionPolicyAssignments`;
- `eventRetentionSettings`; and
- `eventRetentionState`.

No existing `events`, `dataSources`, time-series, or summary row needs a rewrite
or backfill. V1 uses the existing `events.by_source_category_time` index.

Generic upgrade path for consumers that do not want event retention:

1. update the package;
2. deploy the additive component schema; and
3. do nothing else.

With no active revision, all events remain forever and event-maintenance work
does not run repeatedly.

Generic activation path:

1. deploy the package and schema;
2. create a draft with explicit global fallback;
3. run preview to completion;
4. review eligible event and child counts;
5. activate the exact previewed revision explicitly;
6. monitor bounded maintenance and error status; and
7. expand user preset assignments deliberately.

No application-specific adoption is a component release requirement.

## Versioning

This is a minor release because it adds optional public APIs and additive
tables while preserving retain-forever behavior by default.

The actual number depends on release order. If workout enrichment is `0.10.0`
and live provider webhooks ship as `0.11.0`, event retention would naturally be
`0.12.0`. If a preceding planned feature remains deferred, use the next
available minor version rather than reserving numbers in PRDs.

A major release is required if implementation:

- activates finite retention automatically;
- reuses or changes existing time-series policy meaning;
- deletes samples or summaries as an event-retention side effect;
- makes a new environment/configuration value mandatory for existing users;
- changes existing event query contracts incompatibly; or
- requires rewriting existing event rows in a non-compatible schema migration.

A patch is not appropriate because policy configuration, preview, activation,
and maintenance are new public capabilities.

## Testing Strategy

### Independence from time-series retention

- activating event retention does not modify time-series configuration;
- time-series assignments with the same preset key remain unchanged;
- deleting an event leaves `dataPoints`, rollups, series state, and summaries;
- time-series maintenance leaves events and event-policy state untouched; and
- both maintenance loops can run concurrently without sharing cursors.

### Policy resolution

- all precedence levels resolve deterministically;
- preset miss falls through to defaults;
- built-in fallback is forever;
- duplicate scopes and invalid durations fail;
- provider/category isolation holds; and
- no event-type rule is accidentally accepted in v1.

### Preview and activation

- draft creation cannot schedule deletion;
- preview reports provider/category and child counts;
- incomplete/expired/wrong-revision preview tokens cannot activate;
- configuration hash mismatch cannot activate;
- literal confirmation is required;
- activation performs no large inline deletion; and
- package/schema upgrade with no activation deletes zero rows.

### Timestamp behavior

- occurrence time, not creation/update time, determines expiry;
- exact cutoff remains until a later run;
- historical late-arriving event is skipped under a finite active policy;
- enrichment does not reset age;
- invalid legacy timestamps are reported and skipped; and
- one batch uses one evaluation timestamp.

### Cascade and ownership

- workout deletes segments and zones before its parent;
- sleep deletion removes only its event row/embedded stages;
- matching ephemeral Garmin job state is removed;
- another user's children cannot be selected by crafted IDs;
- a mismatched expected source/user fails closed;
- very large child sets continue in bounded phases; and
- missing rows make retries idempotent.

### Maintenance

- batches stay within configured row/time limits;
- backlog causes prompt coalesced continuation;
- caught-up/forever rules avoid repeated scans;
- duplicate scheduled calls are harmless;
- stale revision work stops;
- a longer replacement policy stops future deletion;
- disconnected users still age out; and
- lifecycle deletion fences take precedence.

### Ingestion coverage

- pull, webhook, Garmin push/backfill, SDK, Synthetic, and file-import paths use
  the retention gate;
- expired events do not reappear after repeated sync;
- retained event upserts continue normally;
- time-series and summary records in the same ingestion request are unaffected;
  and
- optional skipped counts are backward compatible.

### Migration and load

- old schema data deploys with no rewrite;
- no active revision is retain forever;
- preview and maintenance remain bounded over many sources/events;
- state initialization does not scan all event bodies; and
- rollback warnings accurately reflect irreversible deletion.

## Documentation Requirements

Before release, update README, `UPGRADING.md`, the API reference, and Fumadocs
with:

- a clear event-versus-time-series retention comparison;
- exact tables affected and explicitly unaffected;
- rule precedence and duration syntax;
- draft, preview, confirmation, and activation walkthrough;
- provider/category examples without prescribing commercial plans;
- occurrence-time semantics and historical-sync behavior;
- ingestion gating and skipped-event reporting;
- owned-child cascade behavior;
- maintenance scheduling, status, and bounds;
- lifecycle deletion interaction;
- irreversibility, rollback, provider re-sync limitations, and backups; and
- schema-only upgrade instructions for consumers keeping events forever.

Documentation must use destructive-action warnings next to activation examples,
not only in a separate privacy section.

## Acceptance Criteria

- The proposal remains an optional semantic-event extension rather than a
  prerequisite for other lifecycle work.
- Event and time-series retention have separate rules, assignments, settings,
  cursors, activation, and deletion effects.
- Default upgrade behavior retains every existing event forever.
- No finite policy can activate without a completed revision-bound preview and
  explicit confirmation.
- Expiration uses `startDatetime`.
- Expired events cannot be repeatedly resurrected through any supported
  ingestion path.
- Maintenance is bounded, resumable, idempotent, and revision-aware.
- Event deletion verifies user/data-source ownership and removes all registered
  owned children before the parent.
- `dataPoints`, rollups, daily summaries, sources, and connections survive event
  retention unchanged.
- Provider/user deletion fences and concurrent policy changes fail safely.
- Tests, API documentation, Fumadocs, upgrade instructions, and package checks
  are complete before publication.

## Deferred Decisions

1. Event `type` rules, pending a justified query/index design.
2. A separate `dailySummaries` retention policy.
3. Full-event archival rather than permanent deletion.
4. Cross-policy convenience APIs that assign matching event and time-series
   preset names without coupling their stored policies.
5. Provider-neutral retention for future route/course or non-workout semantic
   event categories.
