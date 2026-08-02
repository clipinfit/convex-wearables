---
date: 2026-07-18
status: IMPLEMENTED
priority: P1
semver: minor
owner_repo: convex-wearables
depends_on: time-series-storage-policy
target_version: 0.10.0
---

# Provider-Neutral Workout Enrichment PRD

## Summary

Add normalized workout samples, segments, zones, and optional activity-file
processing without turning `events` into an unbounded document. Garmin FIT,
Garmin activity detail, and Strava streams should feed one provider-neutral
model. The first delivery should favor high-value fields and bounded storage.

Implementation status: the provider-neutral model, Garmin `activityDetails`
samples, FIT laps/splits/lengths/sets/zones/samples, lifecycle deletion, public
read/write contracts, tests, and documentation are complete for `0.10.0`.
Strava streams and optional encrypted raw-file archival remain later work.

The existing [Garmin activity-files plan](./garmin-activity-files-plan.md)
becomes a provider-specific ingestion plan under this broader model.
Strava implementation and host ownership boundaries are defined separately in
the [Strava integration boundaries](./strava-integration-boundaries.md)
decision note.

## Goals

- Preserve workout summary compatibility in `events`.
- Store laps, splits, swim lengths, and future strength sets as child rows.
- Store HR and power zones with explicit boundaries and time-in-zone values.
- Normalize cadence, speed, power, elevation, GPS, temperature, and running
  dynamics into existing time-series storage.
- Parse FIT asynchronously after webhook acknowledgment.
- Apply existing raw/rollup/retention policies to workout samples.
- Allow raw activity-file retention only as an explicit host option.

## Non-goals

- Do not embed unbounded samples or segments in an `events` document.
- Do not retain every raw activity file by default.
- Do not build sport-specific tables for every workout type in the first phase.
- Do not make FIT parsing mandatory for summary ingestion.
- Do not replace provider JSON summaries when they remain authoritative.

## Data model

Add an optional version marker to new enrichment rows rather than changing
existing event documents.

```ts
workoutSegments: {
  eventId: Id<"events">;
  userId: string;
  provider: ProviderName;
  kind: "lap" | "split" | "length" | "set";
  index: number;
  startDatetime?: number;
  elapsedSeconds?: number;
  distanceMeters?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgPower?: number;
  maxPower?: number;
  avgCadence?: number;
  totalStrokes?: number;
  exercise?: string;
  repetitions?: number;
  weightKg?: number;
  metadata?: Record<string, string | number | boolean>;
  schemaVersion: number;
}

workoutZones: {
  eventId: Id<"events">;
  userId: string;
  provider: ProviderName;
  kind: "heart_rate" | "power";
  zone: number;
  lowerBound?: number;
  upperBound?: number;
  seconds?: number;
  schemaVersion: number;
}
```

Required indexes:

- `workoutSegments.by_eventId_and_kind_and_index`
- `workoutSegments.by_userId_and_startDatetime`
- `workoutZones.by_eventId_and_kind_and_zone`

Use new tables so existing `events` indexes do not require backfill or a staged
deployment. If later implementation needs a new index on `events`, ship it
staged first.

## Ingestion architecture

1. A provider webhook or pull sync stores/upserts the workout summary.
2. Sample JSON or a short-lived activity-file callback is queued after the
   summary transaction succeeds.
3. An action downloads the file with strict size, content-type, host, and
   timeout checks.
4. A provider-neutral parser returns bounded batches of normalized samples,
   segments, and zones.
5. Mutations upsert segments/zones by deterministic event identity and write
   samples through `dataPoints.storeBatch`.
6. Raw bytes are discarded unless a host-provided encrypted blob sink is
   explicitly configured.

FIT parsing must enforce maximum file bytes, maximum messages, maximum samples,
and maximum segments. It must reject callback redirects to unapproved hosts and
must never log signed callback URLs.

## Source-of-truth rules

- Provider summary payload owns top-level event duration and basic totals.
- Activity detail or FIT may enrich missing fields but must not silently
  overwrite a non-null summary field unless a documented provider rule says it
  is more authoritative.
- Samples use the event's data source and provider.
- Reprocessing the same file must be idempotent.
- A malformed enrichment payload must not delete or invalidate the summary.

## Phases

### Phase 1: schema and normalized contracts

- Add child tables and read APIs.
- Add normalized segment/zone types.
- Add lifecycle deletion when an event or user is deleted.
- Add retention interaction tests.

### Phase 2: Garmin JSON samples and FIT core

- Heart rate, speed, cadence, power, elevation, GPS, and temperature.
- Laps, splits, swim lengths, HR zones, and power zones.
- Async activity-file callback handling.

### Phase 3: Strava streams

- Map Strava time, lat/lng, altitude, velocity, HR, cadence, watts, and
  temperature streams into the same series model.
- Preserve Strava activity, upload, external-origin, and device attribution
  where the API and approved retention policy allow it.
- Keep cross-provider reconciliation outside component ingestion; the host
  owns canonical display and duplicate suppression.
- Respect the then-current Strava API terms and require explicit per-host
  enablement.

### Phase 4: targeted strength detail

- Add sets, repetitions, exercise name/type, and load when reliable source data
  exists.
- Avoid a universal strength ontology until representative files are tested.

## Migration and existing-user impact

Expected schema change: additive tables and indexes only.

- Existing `events`, `dataPoints`, summaries, and connections remain valid.
- No existing-row rewrite is required.
- No host-run migration is required for deployment.
- Historical workouts remain summary-only unless an operator explicitly runs a
  provider backfill or reprocesses retained raw files.
- Existing reads continue to work; new detail APIs return empty arrays for old
  workouts.
- Rollback is code-safe while new tables remain in schema; a cleanup release may
  remove them only after data disposition is decided.

For any consumer:

1. Update to `0.10.0` and deploy the backend to install the additive schema.
2. Keep existing workout UI on summary reads or opt into the new detail query.
3. Enable Garmin Activity Files explicitly in `registerRoutes` after the
   Garmin application has the corresponding product permission.
4. Review time-series storage policies before ingesting dense workout samples.
5. Do not run a historical backfill by default.

## Acceptance criteria

- Duplicate delivery produces no duplicate segment/zone rows.
- Summary ingestion succeeds when enrichment fails.
- Deleting a workout or user deletes associated child rows in bounded batches.
- Time-series policy applies to workout samples exactly as to other samples.
- FIT byte, sample, segment, and zone limits are enforced; normalization and
  invalid-file behavior are covered by tests.
- Garmin and Strava fixtures produce the same normalized series names.
- Existing `0.6.0` stored data can deploy without migration.
