---
date: 2026-03-22
status: NOT_IMPLEMENTED
semver: minor
---

# Time-Series Storage Policy Plan for `convex-wearables`

## Summary
- Add a component-managed storage policy so consumers can control how high-volume time-series data is stored without blocking full-fidelity sync.
- Treat this as a storage and query policy, not a sync policy. Providers should still ingest all supported data; the policy decides what is retained raw, rolled up, or summarized.
- Start with Garmin as the main driver, but design the policy generically so it also covers Suunto and SDK push sources that can produce dense point streams.

## Goals
- Preserve current behavior by default for backward compatibility.
- Give consumers explicit control over retention and bucket granularity for expensive series like `heart_rate`.
- Keep the component reusable for apps that need either full-fidelity telemetry or only practical product-level charts.
- Centralize enforcement in shared ingestion and query paths instead of scattering provider-specific logic.

## Non-Goals
- Do not reduce provider sync coverage or refuse supported data types.
- Do not make this user-specific in the first iteration.
- Do not introduce a Garmin-only one-off that cannot extend to other providers or SDK push ingestion.

## Why This Is Needed
- Garmin can emit dense heart-rate samples throughout the day, which grows `dataPoints` quickly.
- Similar pressure can appear in other integrations:
  - Suunto activity samples can emit dense `heart_rate`, `steps`, `oxygen_saturation`, and `energy`.
  - SDK push can submit arbitrary raw data-point streams.
- The component already has coarse-grained `dailySummaries`, but current time-series queries still rely on raw `dataPoints`.

## Recommended Product Direction

### 1. Introduce a persisted storage policy surface
- Add a component-owned policy configuration stored in Convex, similar in spirit to persisted provider credentials.
- Policy precedence should be:
  - global defaults
  - provider override
  - series override
- The host app should configure the policy through the component API, but webhook and workflow execution should read the persisted policy from component state.

### 2. Model this as storage modes
- Start with a small set of modes:
  - `full`: store raw points indefinitely, matching current behavior
  - `retained_rollup`: store raw points for a hot window, roll older data into buckets
  - `summary_only`: skip raw long-term storage and rely on summaries or coarse rollups where appropriate
- This keeps full syncing available while giving consumers a deliberate way to manage growth.

### 3. Keep the first policy knobs small and explicit
- `rawRetentionDays`
- `bucketMinutes`
- `aggregations`
- Optional `appliesToProviders`
- Optional `appliesToSeries`

For example, consumers should be able to express:
- keep Garmin `heart_rate` raw for 7 days
- then retain 1-minute buckets for 90 days
- keep daily summaries forever

### 4. Add a rollup storage tier
- Introduce a dedicated bucketed time-series table rather than overloading `dailySummaries`.
- Each rollup bucket should retain enough shape for charts and analytics:
  - `avg`
  - `min`
  - `max`
  - `last`
  - `count`
- A simple average alone is too lossy for heart-rate visualizations.

### 5. Route reads through best-available resolution
- Short-range queries should continue to use raw points when available.
- Longer-range queries should use rollups.
- Date spans that exceed raw retention should never require scanning raw historical points.
- Keep the read contract simple at first; resolution can be inferred from the requested range and policy.

### 6. Roll out Garmin-first, not Garmin-only
- Garmin is the immediate scaling concern and should drive validation of the design.
- The same mechanism should then apply to:
  - Suunto dense activity samples
  - SDK push high-frequency time-series
- Lower-volume providers such as current Whoop recovery/body data can simply remain on `full`.

## Architecture Plan

### Storage policy data model
- Add a dedicated table for time-series storage policies rather than overloading `providerSettings`.
- Keep the schema generic enough to express global, provider-level, and series-level defaults.
- Store policy records as component state so webhook processing, sync workflows, and SDK ingestion all use the same rules.

### Central policy application
- Apply policy in the shared write path around batched data-point storage.
- Avoid baking policy decisions into each provider adapter.
- The enforcement point should sit where normalized points are grouped and written, so Garmin webhooks, pull syncs, and SDK push all behave consistently.

### Rollup lifecycle
- Raw writes enter the hot table first when the selected mode includes raw retention.
- A scheduled compaction path rolls expired raw windows into configured buckets.
- After successful rollup, old raw points are deleted according to retention.

### Query lifecycle
- Query APIs should choose the narrowest necessary source:
  - raw for recent ranges
  - rollups for medium and long ranges
  - `dailySummaries` for aggregate product views where daily data is sufficient
- This reduces both storage cost and query scan pressure.

## Garmin-Specific Considerations
- Review overlapping Garmin heart-rate sources before locking in defaults.
- Daily payloads can already include:
  - `avgHeartRate`
  - `minHeartRate`
  - `maxHeartRate`
  - `restingHeartRate`
  - fine-grained `timeOffsetHeartRateSamples`
- Epoch payloads can also contribute heart-rate points.
- If two Garmin feeds express overlapping semantics, choose one canonical raw source where possible to avoid unnecessary duplication.

## Suggested Initial Defaults
- Global default: `full`
- Garmin `heart_rate`: raw 7-14 days, 1-minute buckets for medium-term history, daily summaries forever
- Garmin `respiratory_rate`, `oxygen_saturation`, `garmin_stress_level`, `garmin_body_battery`: 5-minute buckets unless a host app opts into full retention
- Sparse metrics such as `weight`, `blood_pressure_*`, `resting_heart_rate`, `vo2_max`: keep full storage
- SDK push default remains permissive until consumers opt into storage policy rules

## Rollout Plan
1. Define the policy API shape and persisted schema.
2. Add the rollup table and compaction model.
3. Update shared data-point write paths to consult policy.
4. Update read paths to choose raw vs rollup vs summary data.
5. Add Garmin-focused tests for raw retention, bucket correctness, and query fallback behavior.
6. Extend the same policy behavior to Suunto and SDK push flows.
7. Document recommended presets for common product needs.

## Risks and Tradeoffs
- More storage tiers make reads and maintenance logic more complex.
- Rollups reduce fidelity, so defaults must be conservative and opt-in.
- Per-user configurability would complicate ingestion and backfill behavior; deployment-level policy is a cleaner first version.
- Aggregation design matters: a weak rollup shape will force another migration later.

## Recommendation
- Implement a generic, persisted storage policy with a backward-compatible default of `full`.
- Ship Garmin `heart_rate` as the first practical use case for retention plus bucketing.
- Keep full syncing available at all times; let consumers opt into stricter storage behavior when they need operational control.
