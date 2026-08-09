---
date: 2026-05-19
status: IMPLEMENTED
semver: minor
owner_repo: convex-wearables
linked_app_prds:
  - "../../clipin-app/docs/apple-health-health-connect-prd.md"
  - "../../clipin-app/docs/samsung-health-mobile-sdk-prd.md"
---

# Provider-Aware Daily Summaries PRD

## Summary

This PRD defines the component-side changes needed to make `dailySummaries` safe for multi-provider production use.

The current component stores events and data points with provider/source provenance through `dataSources`, but `dailySummaries` are still keyed by:

```ts
userId + category + date
```

That means a Garmin daily activity summary, Apple Health daily activity summary, Health Connect daily activity summary, or future direct Samsung Health daily activity summary can overwrite another provider's row for the same user/date/category.

Production native-provider rollouts in CLIPIN require `dailySummaries` to preserve provider provenance and allow CLIPIN to choose the effective provider in its own canonical read models.

Hard dependency:
- CLIPIN may allow Garmin, Apple Health, and Health Connect to be connected on the same account
- this component must preserve each provider's daily rows separately before that product behavior is enabled
- if this PRD is not implemented, CLIPIN must keep Apple Health / Health Connect production UI feature-flagged off or avoid sending daily summaries from native providers
- enforcing "only one connected provider" is not the desired product solution because it discards useful non-overlapping provider data and still does not solve mirrored records correctly

## Linked Product Work

- Apple Health and Health Connect app PRD: [../../clipin-app/docs/apple-health-health-connect-prd.md](../../clipin-app/docs/apple-health-health-connect-prd.md)
- Deferred Samsung Health app PRD: [../../clipin-app/docs/samsung-health-mobile-sdk-prd.md](../../clipin-app/docs/samsung-health-mobile-sdk-prd.md)
- Deferred Samsung component dependency PRD: [./samsung-health-integration-prd.md](./samsung-health-integration-prd.md)

Samsung direct SDK work is deferred post-Health-Connect. This PRD remains required for Apple Health, Health Connect, Garmin coexistence, and future direct providers; Samsung references are future-readiness, not a launch blocker for the Apple/Google work.

## Problem

Native health stores are provider families, not direct cloud identities:

- Apple Health component provider id is `apple`.
- Health Connect component provider id is `google`.
- Samsung Health component provider id is `samsung`.
- Garmin direct component provider id is `garmin`.

Within those provider families, source metadata can identify a device, source app, bundle id, package id, or mirrored origin. That metadata is important, but it is not the summary provider identity.

The component must not use `source`, `sourceName`, `originalSourceName`, device model, bundle id, or package id as the daily-summary provider key.

## Reference Implementation Comparison

A related reference implementation stores raw rows through a provider-aware `data_source` table and computes daily activity/sleep summaries on read. Its summary service groups by date plus source/device, then filters to one result per date using priority.

That pattern is not sufficient for this Convex component because:

- this component already exposes persisted `dailySummaries` rows as part of its storage contract;
- source metadata may contain app names or package ids that are not provider ids;
- CLIPIN needs to query provider-family summaries before applying product precedence;
- CLIPIN, not the component, owns final canonical display logic.

The component should therefore store provider-scoped summary rows and expose provider-filtered reads. It should not collapse providers during write or read.

## Goals

- Preserve provider provenance on every new `dailySummaries` row.
- Prevent provider A from overwriting provider B for the same `userId + category + date`.
- Keep SDK push compatibility for existing mobile payloads.
- Let CLIPIN query summaries by provider before applying canonical precedence.
- Keep source metadata available for attribution and mirrored-origin detection.
- Preserve event provenance needed by CLIPIN to distinguish direct-provider workouts from health-store mirrors, even though final duplicate suppression remains a CLIPIN app concern.

## Non-Goals

- Do not implement CLIPIN product precedence inside this component.
- Do not decide whether two cross-provider workouts or sleep sessions are the same real-world event.
- Do not merge Apple Health, Health Connect, Samsung Health, and Garmin into one canonical row.
- Do not enforce a one-provider-per-user connection policy in the component.
- Do not add native mobile SDK logic to this component.
- Do not require a `dataSourceId` for provider-family aggregates that already combine multiple native origins.
- Do not solve source-side deletion reconciliation.

## Required Schema Changes

Add provider/source provenance to `dailySummaries`:

```ts
dailySummaries: defineTable({
  userId: v.string(),
  provider: v.optional(providerName),
  dataSourceId: v.optional(v.id("dataSources")),
  source: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
  date: v.string(),
  category: v.string(),

  // existing summary metric fields...
})
```

Change the primary upsert identity from:

```ts
userId + category + date
```

to:

```ts
userId + provider + category + date
```

Migration note:
- `provider` is optional at the schema layer so legacy rows without provider provenance remain readable
- `provider` is required at the new write/upsert API boundary
- provider-filtered reads do not return unprovidered legacy rows

Recommended indexes:

- `by_user_provider_category_date`
- `by_user_provider_date`
- `by_user_category_date` retained only for migration or compatibility reads

Optional future index if the component later supports multiple summaries per provider/day/category:

- `by_user_provider_source_category_date`

Do not add that future index for launch unless a concrete caller needs multiple source-scoped summaries for the same provider/day/category.

## Summary Identity Rules

- `provider` is required for every new summary.
- `provider` must come from the provider context of the ingestion path, not from source metadata.
- Health Connect summaries use `provider = "google"`.
- Apple Health summaries use `provider = "apple"`.
- Samsung Health summaries use `provider = "samsung"`.
- Garmin summaries use `provider = "garmin"`.
- `source` may describe the provider sub-surface, such as `healthkit`, `health-connect`, `samsung-health`, or `garmin`.
- `originalSourceName` may preserve the source app, package id, bundle id, device label, or mirrored-origin detail.
- `dataSourceId` is optional and should only be set when the summary genuinely maps to one `dataSources` row.
- If a daily aggregate is provider-family-level and may include multiple native sources, omit `dataSourceId` and keep provider-level provenance.

## Ingestion Changes

### SDK Push

`sdkPush.ingestNormalizedPayload` must pass provider provenance into summary upserts.

For each summary in `summaries` or `dailySummaries`:

- set `provider` to `args.provider`;
- carry `source` and `originalSourceName` from summary-level metadata if added later;
- otherwise carry source metadata from `sourceMetadata` or `device` only when it represents the whole summary;
- do not infer provider from `source`;
- do not require `dataSourceId` for health-store daily aggregates.

This behavior must apply equally to `apple`, `google`, and `samsung`.

### Cloud Provider Sync

Cloud-provider sync paths that write summaries, including Garmin, must pass their provider into `internal.summaries.upsert`.

For Garmin:

- write `provider = "garmin"`;
- set `source = "garmin"` where useful;
- set `dataSourceId` only if the summary is tied to one known Garmin `dataSources` row.

### Upsert Mutation

`internal.summaries.upsert` must accept:

```ts
{
  userId: string;
  provider: ProviderName;
  date: string;
  category: string;
  dataSourceId?: Id<"dataSources">;
  source?: string;
  originalSourceName?: string;
  // metric fields...
}
```

The mutation must look up existing rows by `userId + provider + category + date`.

## Read API Changes

Extend the component client and component query to support provider-filtered reads:

```ts
getDailySummaries(ctx, {
  userId,
  provider?: ProviderName,
  category,
  startDate,
  endDate,
});
```

Rules:

- if `provider` is provided, return only that provider's summaries;
- if `provider` is omitted, return provider-mixed rows and document that the result is not canonical;
- return provider/source metadata with each summary row;
- do not choose the "best" provider in the component query.

Consumer contract:
- unfiltered summary reads are storage-level reads, not product-canonical reads
- callers that display user-facing daily totals in a multi-provider app must either pass `provider` or apply their own explicit provider precedence after reading provider-scoped rows
- component docs and client types should make it difficult to accidentally treat provider-mixed reads as canonical

Recommended follow-up read improvements:

- event reads filterable by `provider` and `dataSourceId` — implemented by
  `getEventsWithSources` in the `0.13.0` release;
- time-series reads filterable by `provider` and `dataSourceId` — implemented
  by `getTimeSeriesWithSources` in the `0.13.0` release;
- event and point reads that return resolved provider/source metadata —
  implemented through per-row `dataSourceId` plus a normalized `dataSources`
  sidecar; see [Source-Aware Reads](./source-aware-reads-prd.md).

Event provenance rule:

- the component should keep storing workout and sleep events with stable external ids, event windows, normalized type, metric fields, and `dataSourceId`;
- event reads should either return resolved provider/source metadata or make it cheap for CLIPIN to join from `dataSourceId`;
- the component must not collapse a health-store mirror into a direct-provider event during ingest or read.

## Migration Behavior

Existing summary rows do not have provider provenance.

Required migration behavior:

- leave legacy rows readable during migration;
- ensure all new writes include `provider`;
- backfill Garmin rows with `provider = "garmin"` when safely knowable;
- for ambiguous legacy rows, either leave them legacy-only or mark them with a migration field rather than guessing;
- document that unprovidered legacy summaries are not valid canonical multi-provider rows.

Compatibility rule:

- existing `getDailySummaries` callers may continue to work, but once multiple providers are enabled, CLIPIN must call provider-filtered reads and apply its own precedence.

## Testing Requirements

Add component tests for:

- two providers writing the same `userId + category + date` without clobbering each other;
- `sdkPush.ingestNormalizedPayload` storing `provider = "apple"`;
- `sdkPush.ingestNormalizedPayload` storing `provider = "google"`;
- Garmin summary writes storing `provider = "garmin"`;
- provider-filtered `getDailySummaries` returning only requested provider rows;
- unfiltered `getDailySummaries` returning provider-mixed rows with provenance;
- legacy rows without provider staying readable but not being returned as provider-filtered rows unless migrated.
- client/API documentation warns that unfiltered summary reads are non-canonical once multiple providers exist.

Deferred Samsung direct test:
- `sdkPush.ingestNormalizedPayload` storing `provider = "samsung"` should be covered when direct Samsung Health is revived; it is not launch-blocking for the Apple/Google Health Connect rollout.

## Acceptance Criteria

- `dailySummaries` rows include provider provenance for all new writes.
- Apple, Google, and Garmin can each write the same user/date/category without overwriting one another.
- Samsung direct follows the same behavior when the deferred Samsung SDK PRD is revived.
- CLIPIN can query one provider's daily summaries independently from other providers.
- Source metadata is preserved without being treated as provider identity.
- Existing SDK push event and data-point behavior remains compatible.
- Existing tests pass after schema and API updates.
- New tests cover multi-provider summary coexistence and provider-filtered reads.

## Implementation Touchpoints

- [src/component/schema.ts](/Users/denis/git/clipin/convex-wearables/src/component/schema.ts)
- [src/component/summaries.ts](/Users/denis/git/clipin/convex-wearables/src/component/summaries.ts)
- [src/component/sdkPush.ts](/Users/denis/git/clipin/convex-wearables/src/component/sdkPush.ts)
- [src/component/syncWorkflow.ts](/Users/denis/git/clipin/convex-wearables/src/component/syncWorkflow.ts)
- [src/component/garminWebhooks.ts](/Users/denis/git/clipin/convex-wearables/src/component/garminWebhooks.ts)
- [src/client/index.ts](/Users/denis/git/clipin/convex-wearables/src/client/index.ts)
- [src/client/types.ts](/Users/denis/git/clipin/convex-wearables/src/client/types.ts)
