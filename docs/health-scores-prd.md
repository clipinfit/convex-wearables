---
date: 2026-07-18
status: DEFERRED_APPLICATION_OWNED
priority: DEFERRED
semver: minor
owner_repo: convex-wearables
---

# Health Scores PRD

## Status

Deferred from the component pipeline. Open Wearables provides a legitimate
reference implementation, but that alone is not a strong enough reason to make
scores a framework primitive. In the current architecture, canonical score
meaning, cross-source reconciliation, presentation, and AI-consent eligibility
belong to the consuming application.

Revisit this PRD only if a concrete requirement emerges to preserve
provider-authored score provenance across multiple consumers, or if several
host apps would otherwise implement the same normalized storage contract.

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

## Existing Consumer Upgrade Path

Schema impact: additive `healthScores` table and indexes. Existing tables and
validators remain compatible, so deploying the first implementation requires
no existing-row rewrite.

For `../clipin-app`:

1. Update the package only after an operator publishes the compatibility release.
2. Deploy the backend before adding any calls to health-score component APIs.
3. Keep existing `dailySummaries` score reads working during dual-write.
4. Adopt CLIPIN wrapper queries and UI incrementally.
5. Run the optional component-owned backfill only if historical score UI is
   required; otherwise new records begin at deployment time.
6. Verify backfill counts and score ranges before switching canonical reads.

The optional historical backfill is a data migration even though schema deploy
is migration-free. It must be resumable, idempotent, observable, and opt-in.

## Acceptance Criteria

- Existing `0.6.0` data deploys without rewrite.
- Provider and internal scores cannot collide under the same identity key.
- Reprocessing a provider payload is idempotent.
- Sleep-linked scores recalculate after an authoritative sleep update.
- Dual-write keeps existing summary consumers compatible.
- Optional backfill reports scanned, inserted, updated, skipped, and failed counts.

## Open Questions

- Should `provider` allow `"internal"` in the same field as provider names or use a separate `scoreSource` field?
- Should score ranges be exported as metadata?
