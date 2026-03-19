# Outbound Garmin Training v1 for `convex-wearables`

## Summary
- Add a parallel outbound subsystem, separate from ingestion/sync/webhook logic, so the component can send normalized training data to provider integrations without disturbing the current inbound engine.
- V1 supports Garmin Training API only, exposed through typed `WearablesClient` methods backed by durable outbound jobs and status queries.
- The public outbound payload is a component-owned normalized training schema for **strength workouts**. It does not leak Garmin request shapes or Garmin exercise enums.
- Garmin mapping is seeded from the local Garmin Training docs/catalog: strength workouts, workout schedules, `WORKOUT_IMPORT`, supported exercise categories, and the Garmin exercise catalog.

## Garmin API Findings
- Garmin Training API creates workouts with `POST /training-api/workout` and schedules them with `POST /training-api/schedule/`.
- Strength workouts are represented as `sport: "STRENGTH_TRAINING"` plus a `steps` array made of `WorkoutStep` and `WorkoutRepeatStep`.
- Reps are represented with `durationType: "REPS"` and `durationValue: <rep count>`.
- Rest is represented as a separate step using `intensity: "REST"` and `durationType: "FIXED_REST"`.
- Weight is passed as `weightValue` in kilograms. `weightDisplayUnit` controls display only.
- Garmin supports repeat blocks through `WorkoutRepeatStep` with `repeatType: "REPEAT_UNTIL_STEPS_CMPLT"` and `repeatValue`.
- `exerciseCategory` is constrained to Garmin-supported constants.
- `exerciseName` should also be treated as Garmin-controlled, not free-form. The newer local Training API docs point both `exerciseCategory` and `exerciseName` to Garmin appendix/catalog values.
- The component should therefore expose provider-agnostic exercise keys publicly and map those internally to Garmin category/name pairs.

### Garmin strength payload reference
```json
{
  "workoutName": "Upper Body Strength A",
  "description": "3x10 bench press",
  "sport": "STRENGTH_TRAINING",
  "estimatedDurationInSecs": 900,
  "workoutProvider": "clipin",
  "workoutSourceId": "clipin-strength-001",
  "steps": [
    {
      "type": "WorkoutRepeatStep",
      "stepOrder": 1,
      "repeatType": "REPEAT_UNTIL_STEPS_CMPLT",
      "repeatValue": 3,
      "skipLastRestStep": true,
      "steps": [
        {
          "type": "WorkoutStep",
          "stepOrder": 2,
          "intensity": "ACTIVE",
          "description": "Bench press set",
          "durationType": "REPS",
          "durationValue": 10,
          "durationValueType": null,
          "targetType": "OPEN",
          "targetValue": null,
          "targetValueLow": null,
          "targetValueHigh": null,
          "targetValueType": null,
          "secondaryTargetType": null,
          "secondaryTargetValue": null,
          "secondaryTargetValueLow": null,
          "secondaryTargetValueHigh": null,
          "secondaryTargetValueType": null,
          "strokeType": null,
          "drillType": null,
          "equipmentType": null,
          "exerciseCategory": "BENCH_PRESS",
          "exerciseName": "BARBELL_BENCH_PRESS",
          "weightValue": 60,
          "weightDisplayUnit": "KILOGRAM"
        },
        {
          "type": "WorkoutStep",
          "stepOrder": 3,
          "intensity": "REST",
          "description": "Rest",
          "durationType": "FIXED_REST",
          "durationValue": 90,
          "durationValueType": null,
          "targetType": "OPEN",
          "targetValue": null,
          "targetValueLow": null,
          "targetValueHigh": null,
          "targetValueType": null,
          "secondaryTargetType": null,
          "secondaryTargetValue": null,
          "secondaryTargetValueLow": null,
          "secondaryTargetValueHigh": null,
          "secondaryTargetValueType": null,
          "strokeType": null,
          "drillType": null,
          "equipmentType": null,
          "exerciseCategory": null,
          "exerciseName": null,
          "weightValue": null,
          "weightDisplayUnit": null
        }
      ]
    }
  ]
}
```

## Implementation Changes

### 1. Public outbound surface
- Add new client methods for:
  - `sendTrainingWorkout(ctx, { connectionId, workout, idempotencyKey? })`
  - `getOutboundJob(ctx, { jobId })`
  - `listOutboundJobs(ctx, { userId, provider?, limit? })`
  - `listSupportedTrainingExercises(ctx, { provider: "garmin", kind: "strength" })`
- Keep this surface action/query based. Do not add HTTP endpoints for v1.
- Keep existing inbound client APIs untouched.

### 2. Separate outbound architecture
- Introduce a new outbound provider contract/registry instead of extending the current inbound `ProviderAdapter` sync path.
- Add a durable outbound workflow plus a dedicated `outboundJobs` table, reusing current job semantics: status, workflow id, error, attempts, timestamps, idempotency key, and provider result references.
- Store the normalized outbound payload snapshot on the job for audit/debug/retry safety.
- Do not route outbound through `syncWorkflow`, webhook handlers, or event ingestion tables.

### 3. Normalized v1 training schema
- Define a component-owned normalized input for `training.kind = "strength"`.
- The workout shape should include:
  - title and optional description
  - optional `scheduledDate` (`YYYY-MM-DD`) for provider scheduling
  - ordered exercises
  - per exercise: canonical `exerciseKey`
  - per set: reps, optional weight with explicit unit, optional `restAfterSeconds`
- Reject unknown exercise keys in v1. No freeform-name fallback and no Garmin-specific request hints in the public payload.
- Keep the schema provider-agnostic so future providers can map into it without changing caller payloads.

### Normalized payload direction
- Public payloads should be ergonomic and provider-agnostic.
- `exerciseKey` should be the canonical mapping key.
- `displayName` may be accepted for UI/debug purposes, but should not drive provider mapping.
- `blocks` is preferable to a flat `exercises[]` array because it can later support circuits, supersets, cardio intervals, explicit rest blocks, and provider-specific compilation without changing the caller contract.
- V1 implementation remains strength-only, but the shape should not block future `kind: "cardio"` support.

### Normalized strength example
```json
{
  "kind": "strength",
  "title": "Upper Body A",
  "description": "Push-focused session",
  "schedule": {
    "date": "2026-03-24",
    "timezone": "Europe/Madrid"
  },
  "blocks": [
    {
      "type": "exercise",
      "exerciseKey": "barbell_bench_press",
      "displayName": "Barbell Bench Press",
      "notes": "Pause 1 second at the bottom",
      "sets": [
        {
          "setType": "warmup",
          "goal": { "type": "reps", "value": 12 },
          "load": { "value": 20, "unit": "kg" },
          "restAfterSeconds": 60
        },
        {
          "setType": "working",
          "goal": { "type": "reps", "value": 10 },
          "load": { "value": 60, "unit": "kg" },
          "restAfterSeconds": 90
        },
        {
          "setType": "working",
          "goal": { "type": "reps", "value": 10 },
          "load": { "value": 60, "unit": "kg" },
          "restAfterSeconds": 90
        },
        {
          "setType": "working",
          "goal": { "type": "reps", "value": 8 },
          "load": { "value": 65, "unit": "kg" },
          "restAfterSeconds": 120
        }
      ]
    },
    {
      "type": "exercise",
      "exerciseKey": "plank",
      "displayName": "Plank",
      "sets": [
        {
          "setType": "working",
          "goal": { "type": "time", "seconds": 45 },
          "restAfterSeconds": 45
        },
        {
          "setType": "working",
          "goal": { "type": "time", "seconds": 45 },
          "restAfterSeconds": 45
        }
      ]
    }
  ],
  "sourceId": "clipin-workout-123"
}
```

### Normalized cardio example
This example is future-facing schema direction only. It is not part of the v1 delivery scope.

```json
{
  "kind": "cardio",
  "title": "Bike Intervals",
  "description": "4 x 1 min hard / 2 min easy",
  "schedule": {
    "date": "2026-03-25",
    "timezone": "Europe/Madrid"
  },
  "blocks": [
    {
      "type": "interval",
      "intensity": "warmup",
      "goal": { "type": "time", "seconds": 300 }
    },
    {
      "type": "repeat",
      "repeat": 4,
      "steps": [
        {
          "type": "interval",
          "intensity": "work",
          "goal": { "type": "time", "seconds": 60 }
        },
        {
          "type": "rest",
          "goal": { "type": "time", "seconds": 120 }
        }
      ]
    },
    {
      "type": "interval",
      "intensity": "cooldown",
      "goal": { "type": "time", "seconds": 300 }
    }
  ],
  "sourceId": "clipin-cardio-001"
}
```

### 4. Canonical exercise catalog and Garmin mapping
- Add a checked-in component-owned exercise manifest for v1 strength support.
- Each catalog entry should carry stable component metadata plus Garmin mapping data:
  - component `exerciseKey`
  - Garmin `exerciseCategory`
  - Garmin `exerciseName`
- Seed the Garmin map from the local Garmin resources rather than hard-coding ad hoc strings.
- Expose the catalog through the new query surface so host apps can discover valid exercise keys instead of embedding Garmin constants.

### 5. Garmin outbound adapter
- Implement Garmin workout creation through Training API workout creation, then optional schedule creation when `scheduledDate` is present.
- Preflight on connection capability:
  - require active Garmin connection
  - require valid token
  - require `WORKOUT_IMPORT` in stored/refreshed permissions
- Keep all Garmin-specific auth/header quirks inside the Garmin outbound adapter so inbound OAuth/webhook code remains unchanged.
- Mapping rules:
  - map each normalized exercise/set sequence into Garmin steps
  - emit `FIXED_REST` steps when rest is present
  - collapse consecutive identical sets into Garmin repeat blocks when safe; otherwise emit explicit steps
- Persist returned Garmin identifiers on the outbound job.

## Test Plan
- Unit tests for normalized schema validation and exercise catalog lookup.
- Unit tests for Garmin mapping:
  - single exercise, multiple sets
  - mixed reps/weights
  - rest between sets
  - optional schedule creation
  - unsupported exercise key
- Workflow tests:
  - idempotent duplicate send returns existing job
  - permission missing fails cleanly
  - token refresh path works
  - Garmin API error is surfaced and job is marked failed
- Regression tests:
  - no changes to existing webhook/sync/backfill behavior
  - inbound tests remain green without modification except shared-helper extraction if needed

## Assumptions and Defaults
- V1 is Garmin-only for outbound and strength-only for the normalized training domain.
- `scheduledDate` is optional; without it, v1 creates only the Garmin workout.
- The component owns canonical exercise keys; host apps map their own exercise ids to those keys outside the component.
- Unknown exercises fail validation instead of best-effort guessing.
- Inbound logic is preserved as-is; outbound may reuse shared auth/token helpers and existing stored connection scope, but must not change ingestion flow unless a small shared helper extraction makes that cleaner.
