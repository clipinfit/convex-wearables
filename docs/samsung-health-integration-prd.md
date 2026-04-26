---
date: 2026-04-25
status: NOT_IMPLEMENTED
semver: minor
owner_repo: convex-wearables
linked_mobile_prd: "../../clipin-app/docs/samsung-health-mobile-sdk-prd.md"
---

# Samsung Health Mobile SDK Component Dependencies

## Summary

Samsung Health should be implemented in the CLIPIN mobile app as an Android mobile SDK integration. The mobile app should read Samsung Health on-device, normalize records into the existing `@clipin/convex-wearables` SDK push payload, and call a CLIPIN-authenticated backend wrapper.

The component already supports the core ingestion path needed for Samsung:

- provider id `"samsung"` is part of `ProviderName`
- `sdkPush.ingestNormalizedPayload` accepts `"samsung"`
- SDK push stores into `connections`, `dataSources`, `events`, `dataPoints`, and `dailySummaries`

This PRD is therefore not the main Samsung implementation plan. The main plan lives in [clipin-app Samsung Health Mobile SDK PRD](../../clipin-app/docs/samsung-health-mobile-sdk-prd.md).

This component PRD only tracks component-side dependencies that must be solved before Samsung Health can be safely enabled in a multi-provider CLIPIN production account.

## Why Any Component Work Is Still Needed

The current normalized SDK push path is enough for a mobile app to send Samsung events and data points.

The production risk is daily summaries and canonical reads:

- `dailySummaries` are currently keyed by `userId + category + date`
- native providers such as Apple Health, Health Connect, and Samsung Health need provider/source attribution
- if Garmin and Samsung both write activity summaries for the same day, the last writer can overwrite the other provider's totals
- user-facing CLIPIN surfaces need source-aware reads so they can apply provider precedence instead of blindly mixing providers

This is the same component dependency already documented by `clipin-app` for Apple Health and Health Connect. Samsung should rely on the same fix rather than introducing Samsung-specific storage.

## Goals

- Keep Samsung Health as a normalized SDK push provider.
- Avoid adding Samsung OAuth, webhooks, or provider pull sync.
- Make `dailySummaries` provider-aware so mobile health-store summaries do not overwrite Garmin or each other.
- Expose enough provider/source filtering for CLIPIN to build canonical health surfaces.
- Preserve backward compatibility for existing SDK push payloads where possible.

## Non-Goals

- Do not parse Samsung Health Data SDK payloads inside this component.
- Do not add Samsung-specific native SDK code to this repo.
- Do not store raw Samsung Health payloads.
- Do not add a Samsung provider adapter to `src/component/providers`.
- Do not implement cross-provider product precedence inside the component.

## Required Component Changes

### 1. Provider-Aware Daily Summaries

Add provider provenance to `dailySummaries`:

```ts
dailySummaries: {
  userId: string;
  provider: ProviderName;
  dataSourceId?: Id<"dataSources">;
  source?: string;
  originalSourceName?: string;
  date: string;
  category: string;
  // existing summary fields...
}
```

Change summary upsert identity from:

```ts
userId + category + date
```

to:

```ts
userId + provider + category + date
```

Recommended indexes:

- `by_user_provider_category_date`
- `by_user_provider_date`
- keep existing user/category/date read support during migration if needed

### 2. SDK Push Summary Provenance

When `sdkPush.ingestNormalizedPayload` receives `provider: "samsung"`, summaries should be written with:

- `provider: "samsung"`
- source metadata from `sourceMetadata` or `device` when available

The same behavior should apply to `"apple"` and `"google"` so all native providers share one model.

### 3. Provider-Filtered Reads

Add or extend read APIs so CLIPIN can ask for provider-specific data before applying its own precedence:

```ts
getDailySummaries(ctx, {
  userId,
  provider?: ProviderName,
  category,
  startDate,
  endDate,
});
```

Recommended non-blocking read improvements:

- event reads that can filter by provider or data source
- time-series reads that can filter by provider or data source
- resolved source metadata on event/point read results

### 4. Migration Behavior

Existing summaries do not have provider provenance.

Recommended migration:

- leave existing rows readable as legacy rows
- write all new SDK summaries with provider provenance
- optionally backfill legacy Garmin summaries with `provider: "garmin"` when the source is knowable
- document that legacy summary rows may be ambiguous until migrated

## Acceptance Criteria

- Samsung SDK pushes can write summaries without overwriting Garmin summaries for the same user/date/category.
- Apple, Google, and Samsung SDK pushes use the same summary provenance behavior.
- CLIPIN can query Samsung summaries separately from Garmin summaries.
- Existing event and data-point SDK push behavior remains compatible.
- Existing tests for normalized SDK push still pass.
- New tests cover two providers writing the same date/category without clobbering each other.

## Linked Work

- Main mobile implementation PRD: [Samsung Health Mobile SDK PRD](../../clipin-app/docs/samsung-health-mobile-sdk-prd.md)
- Existing native-provider plan in CLIPIN: [Apple Health and Health Connect Integration PRD](../../clipin-app/docs/apple-health-health-connect-prd.md)
- Existing component ingestion file: [src/component/sdkPush.ts](/Users/denis/git/clipin/convex-wearables/src/component/sdkPush.ts)
- Current summaries implementation: [src/component/summaries.ts](/Users/denis/git/clipin/convex-wearables/src/component/summaries.ts)
