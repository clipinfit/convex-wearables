# Event Retention Policy PRD

## Status

Proposed. Not planned for immediate implementation.

## Background

`convex-wearables` currently has configurable retention for time-series data through the time-series storage policy model. That policy governs dense metric samples in `dataPoints` and historical aggregates in `timeSeriesRollups`.

The component also stores lower-volume but product-important records in `events`, including workouts and sleep sessions. These records currently have no retention policy. They are retained indefinitely unless explicitly deleted by a provider delete webhook, user/account deletion, or a host-app custom cleanup.

Indefinite event retention is acceptable as a simple default, but it is not sufficient for products that need different historical access by subscription plan or deployment policy.

Example:

- Free: keep workouts for 30 days.
- Pro: keep workouts for 3 months.
- Premium: keep workouts forever.
- Enterprise/research: keep sleep sessions for 2 years, workouts forever.

This is not primarily a row-volume problem. It is a product, privacy, cost, and plan-entitlement problem.

## Goals

- Allow host apps to configure retention for `events`.
- Support deployment-wide defaults.
- Support named presets that can be assigned per user, matching the existing time-series policy direction.
- Keep the default behavior backward-compatible: events are retained forever unless a policy is configured.
- Allow different retention by event category, provider, and optionally event type.
- Make expired event deletion explicit, bounded, and observable.
- Reuse the existing maintenance-loop philosophy where possible.

## Non-Goals

- Do not compact events into rollups. Events are semantic records, not dense samples.
- Do not redesign workout or sleep event schemas.
- Do not delete event-linked time-series data implicitly unless a separate policy explicitly says so.
- Do not solve Garmin activity file/detail retention in this first policy. Deep activity-file storage should remain a separate policy domain if implemented.
- Do not make retention changes silently destructive on deploy.

## Current Behavior

The `events` table stores workouts and sleep sessions with fields such as:

- `userId`
- `dataSourceId`
- `category`
- `type`
- `sourceName`
- `startDatetime`
- `endDatetime`
- provider-specific summary/detail fields

The current delete paths are explicit:

- `deleteByExternalId`, used by provider delete webhooks such as Strava activity deletion.
- `deleteUserEvents`, used for account/user deletion.
- `deleteAllUserData`, which deletes all component data for a user.

There is no age-based event retention and no event maintenance cursor.

## Proposed Policy Model

Add an event retention policy alongside the existing time-series policy.

The policy should support:

- global rules
- provider-scoped rules
- category-scoped rules
- provider + category rules
- optional event `type` rules
- named presets
- user preset assignment

Example shape:

```ts
await wearables.replaceEventRetentionPolicyConfiguration(ctx, {
  defaultRules: [
    {
      // Backward-compatible fallback.
      retainFor: null,
    },
    {
      category: "workout",
      retainFor: "90d",
    },
    {
      category: "sleep",
      retainFor: "365d",
    },
  ],
  presets: [
    {
      key: "premium",
      rules: [
        {
          category: "workout",
          retainFor: null,
        },
        {
          category: "sleep",
          retainFor: null,
        },
      ],
    },
    {
      key: "pro",
      rules: [
        {
          category: "workout",
          retainFor: "90d",
        },
        {
          category: "sleep",
          retainFor: "180d",
        },
      ],
    },
  ],
  maintenance: {
    enabled: true,
    interval: "1h",
  },
});
```

`retainFor: null` means retain forever.

Alternative naming to consider:

- `deleteAfter`
- `maxAge`
- `retention`
- `retentionWindow`

`retainFor` is readable from a product perspective and matches plan language well.

## Rule Resolution

Policy resolution should mirror time-series policy precedence.

Suggested precedence from most specific to least specific:

1. assigned preset: provider + category + type
2. assigned preset: provider + category
3. assigned preset: category + type
4. assigned preset: provider
5. assigned preset: category
6. assigned preset: global
7. deployment default: provider + category + type
8. deployment default: provider + category
9. deployment default: category + type
10. deployment default: provider
11. deployment default: category
12. deployment default: global
13. built-in fallback: retain forever

The first matching rule wins.

## Scope Fields

Rules should support:

```ts
type EventRetentionRuleInput = {
  provider?: ProviderName;
  category?: "workout" | "sleep";
  type?: string;
  retainFor: string | number | null;
};
```

Open question: whether `type` should be supported in the first release. It adds useful control, but also increases matching complexity and test surface.

Examples:

- Keep Garmin workouts for 90 days.
- Keep sleep events forever.
- Keep manually imported test provider events for 7 days.
- Keep only `running` workouts forever for a coaching product.

## User Presets

The existing time-series policy supports named presets assigned by user. Event retention should follow the same model rather than inventing a separate entitlement model.

Potential APIs:

```ts
await wearables.setUserEventRetentionPolicyPreset(ctx, {
  userId,
  presetKey: "premium",
});
```

Open question: whether event retention and time-series retention should share one assignment table/preset key, or stay separate.

Recommended initial direction:

- Keep policy tables separate.
- Allow host apps to assign the same preset key to both systems from their subscription logic.
- Avoid assuming every app wants event retention and time-series retention tiers to match exactly.

## Maintenance Lifecycle

Event retention requires scheduled maintenance because events age out even if the user stops syncing.

The maintenance job should:

- find users/data sources/events due for retention cleanup;
- delete expired events in bounded batches;
- track progress without full-table scans;
- reschedule itself while backlog remains;
- expose status/debug information.

Potential state table:

```ts
eventRetentionState: {
  userId: string;
  provider?: ProviderName;
  category?: EventCategory;
  nextMaintenanceAt: number;
  lastMaintenanceAt?: number;
  lastDeletedEventStartDatetime?: number;
  updatedAt: number;
}
```

Alternative: avoid per-user state and query `events` directly by indexed cutoff. This is simpler but risks broad scans unless carefully indexed.

Needed indexes may include:

- `events.by_user_category_time`
- `events.by_source_category_time`
- potentially new `events.by_user_provider_category_time` if provider is denormalized, or use `dataSources` joins in bounded steps.

Convex does not support joins, so denormalizing `provider` onto `events` may be worth considering if provider-scoped retention is required efficiently.

## Deletion Semantics

When an event expires:

- delete the `events` row;
- do not delete `dataPoints`;
- do not delete `dailySummaries` unless a separate daily-summary policy exists;
- do not delete source/dataSource rows;
- optionally emit an internal maintenance result for observability.

Reasoning:

- A workout event is a semantic record.
- Time-series samples and daily summaries have separate policies and uses.
- Coupled deletion would make retention behavior hard to reason about.

## Query Behavior

Queries do not need to know the retention policy directly. Expired events should be physically deleted by maintenance.

However, host apps may want policy introspection APIs:

```ts
await wearables.getEventRetentionPolicyConfiguration(ctx);
await wearables.getUserEventRetentionPolicyPreset(ctx, { userId });
await wearables.getEffectiveEventRetentionPolicy(ctx, {
  userId,
  provider: "garmin",
  category: "workout",
  type: "running",
});
```

These mirror existing time-series policy APIs and make admin/support tooling easier.

## Backward Compatibility

Default behavior must remain:

```ts
retainFor: null
```

That means existing consumers do not lose event history after upgrading.

No event rows should be deleted until the host app explicitly persists an event retention policy with finite windows and enables maintenance.

## Observability

Expose enough status to debug:

- configured default rules
- configured presets
- maintenance enabled/disabled
- last maintenance run
- last error
- number of events deleted in last run
- backlog signal, if known

Avoid requiring consumers to inspect component tables directly.

## Open Questions

- Should event retention and time-series retention share one generic policy framework, or stay separate APIs with similar shapes?
- Should `dailySummaries` get its own retention policy in the same project, or remain out of scope?
- Should event `provider` be denormalized onto `events` to make provider-scoped deletion efficient?
- Should retention apply to `startDatetime` or `_creationTime`?
- Should disconnected users continue aging out under policy? Initial answer should be yes, matching time-series behavior.
- Should plan downgrades immediately delete older events or only hide them from queries until maintenance deletes them?
- Should event retention offer a dry-run/count API before applying destructive policy changes?

## Suggested Milestones

### Milestone 1: Policy Storage And Introspection

- Add event retention policy tables.
- Add replace/get/effective policy APIs.
- Add preset assignment API.
- No deletion yet.

### Milestone 2: Bounded Maintenance

- Add event cleanup state/settings.
- Delete expired events in bounded batches.
- Add maintenance scheduling and status.
- Add tests for default forever behavior and finite retention.

### Milestone 3: Host-App Ergonomics

- Add examples for Free/Pro/Premium plans.
- Add docs explaining interaction with time-series and daily summaries.
- Consider a health-check API that reports missing policy setup.

## Success Criteria

- A host app can configure Free/Pro/Premium event retention without custom cleanup code.
- Existing apps retain events forever unless they opt in.
- Expired events are physically deleted in bounded background work.
- Per-user preset changes are reflected by maintenance without redeploying.
- Time-series policy and event retention remain understandable as separate but related storage controls.
