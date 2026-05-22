# Health Scores PRD

## Status

Draft.

## Source Signal

A reference implementation added a `health_score` model, provider score ranges, provider score ingestion, sleep score recalculation after sleep merge, resilience score tasks, and a recovery summary endpoint.

## Problem

`convex-wearables` currently stores scores mostly as time-series values or fields on `dailySummaries`. That is useful for charts, but it loses score semantics:

- score category and provider range;
- score components;
- association to a sleep event;
- distinction between provider scores and internal computed scores;
- recalculation lifecycle.

## Goals

- Add first-class `healthScores` storage.
- Support provider scores and internal scores.
- Preserve existing daily summary fields for backward compatibility.
- Allow future sleep, resilience, readiness, strain, stress, and body battery scoring.

## Non-Goals

- Do not remove existing score-like series types.
- Do not implement all internal score algorithms in the first phase.
- Do not backfill all historical scores automatically without an explicit migration action.

## Requirements

- Add `healthScores` table:

```ts
healthScores: {
  userId: string;
  dataSourceId?: Id<"dataSources">;
  provider: ProviderName | "internal";
  category: "sleep" | "recovery" | "readiness" | "activity" | "stress" | "resilience" | "body_battery" | "strain";
  value?: number;
  qualifier?: string;
  recordedAt: number;
  zoneOffset?: string;
  components?: Record<string, unknown>;
  sleepEventId?: Id<"events">;
}
```

- Indexes:
  - `by_user_category_time`
  - `by_user_provider_category_time`
  - `by_sleep_event`
- Add upsert helpers by `userId + provider + category + recordedAt`.
- Add `getHealthScores` query.
- Keep writing summary fields such as `dailySummaries.recoveryScore` during the transition.

## Existing User Impact

This requires a component schema migration because it adds a table.

Recommended npm versioning:

- Minor version if table is additive and old APIs keep working.
- Major version only if `dailySummaries` score fields or score series types are removed or renamed.

`../clipin-app` impact:

- Must update the installed package and deploy Convex schema before calling `healthScores` APIs.
- Existing app reads from `dailySummaries` should continue to work.
- New UI can opt in by reading `healthScores`.
- Backfill should be explicit because creating score rows from existing summaries changes query results and storage cost.

## Versioning Guidance

Expected bump: minor (`0.3.0` or later pre-1.0 minor) for an additive `healthScores` table and new APIs.

Use a major release, or the next pre-1.0 minor with explicit breaking notes, if implementation:

- removes score fields from `dailySummaries`;
- stops writing existing score series types such as `recovery_score`;
- changes `getDailySummaries` return shape;
- automatically backfills production data without an explicit host call.

Implementation considerations:

- This requires a Convex schema deploy for existing component users.
- Keep dual writes to summaries/series and `healthScores` for at least one release.
- Backfill should be idempotent, explicitly invoked, and documented with storage-cost expectations.
- `../clipin-app` should update package and deploy schema before calling new score queries.

## Migration Plan

1. Add schema and APIs.
2. Write new scores for new ingestion only.
3. Add an optional backfill action:
   - read score-like daily summaries and data points;
   - write health score rows with deterministic idempotency.
4. Document that existing deployments do not need to run the backfill unless they want historical score queries.

## Open Questions

- Should `provider` allow `"internal"` in the same field as provider names or use a separate `scoreSource` field?
- Should score ranges be exported as metadata?
