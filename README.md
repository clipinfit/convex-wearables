# @clipin/convex-wearables

[![Convex Component](https://www.convex.dev/components/badge/clipin/convex-wearables)](https://www.convex.dev/components/clipin/convex-wearables)

A [Convex component](https://docs.convex.dev/components) for wearable device integrations. Sync health data from **Garmin, Strava, Whoop, Polar, Suunto, Apple HealthKit, Samsung Health, and Google Health Connect**, or generate it with the built-in **Synthetic provider**, in your Convex app.

Built as a drop-in module: install the component, pass your provider credentials, and start querying workouts, sleep sessions, heart rate, and 88 pre-defined health metrics — all in TypeScript, no backend glue code required.

## Features

- **OAuth 2.0 flows** with PKCE support — authorize users, exchange tokens, auto-refresh
- **Automatic sync** — cron-triggered or on-demand data fetching from provider APIs
- **Normalized data model** — workouts, sleep, time-series metrics, and daily summaries in a unified schema
- **40+ workout types** mapped to a unified taxonomy (running, cycling, swimming, yoga, etc.)
- **88 pre-defined series types** — heart rate, HRV, SpO2, steps, weight, body temperature, and more
- **Cursor-based pagination** — efficient data access within Convex's scan limits
- **Configurable time-series storage policy** — keep full raw data, retain recent raw + historical rollups, or store rollups only
- **Deduplication** — events and data points are deduped by external ID and source+timestamp
- **Precomputed daily summaries** — activity, sleep, recovery, and body composition aggregates
- **Durable data lifecycle** — explicit disconnect, provider deregistration, and resumable provider/user deletion workflows
- **Webhook + SDK push support** — durable WHOOP v2, Polar, Suunto, and Garmin inbound webhooks plus normalized mobile SDK ingestion
- **Synthetic provider** — deterministic, explicitly enabled wearable fixtures using the same normalized model
- **Full TypeScript** — end-to-end type safety from provider API to client query

## Installation

```bash
npm install @clipin/convex-wearables convex
```

`convex` is a peer dependency and should be `>= 1.17.0`.

## Quick Start

### 1. Install the component in your Convex app

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import wearables from "@clipin/convex-wearables/convex.config";

const app = defineApp();
app.use(wearables);

export default app;
```

### 2. Create the client

```ts
// convex/wearables.ts
import { WearablesClient, type ProviderName } from "@clipin/convex-wearables";
import { components } from "./_generated/api";

export const wearables = new WearablesClient(components.wearables, {
  providers: {
    strava: {
      clientId: process.env.STRAVA_CLIENT_ID!,
      clientSecret: process.env.STRAVA_CLIENT_SECRET!,
    },
    garmin: {
      clientId: process.env.GARMIN_CLIENT_ID!,
      clientSecret: process.env.GARMIN_CLIENT_SECRET!,
    },
    // Add more providers as needed
  },
});
```

### 3. Use in your queries and mutations

```ts
// convex/workouts.ts
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { wearables } from "./wearables";

// Get a user's recent workouts
export const listWorkouts = query({
  args: {
    userId: v.string(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await wearables.getEvents(ctx, {
      userId: args.userId,
      category: "workout",
      limit: 20,
      cursor: args.cursor,
    });
  },
});

// Get heart rate time-series for the last 24 hours
export const getHeartRate = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await wearables.getTimeSeries(ctx, {
      userId: args.userId,
      seriesType: "heart_rate",
      startDate: now - 24 * 60 * 60 * 1000,
      endDate: now,
    });
  },
});

// Get daily activity summaries for a date range
export const getWeeklySummary = query({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await wearables.getDailySummaries(ctx, {
      userId: args.userId,
      provider: "garmin",
      category: "activity",
      startDate: "2026-03-09",
      endDate: "2026-03-15",
    });
  },
});

// Disconnect a provider
export const disconnectProvider = mutation({
  args: {
    userId: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, args) => {
    await wearables.disconnect(ctx, {
      userId: args.userId,
      provider: args.provider as ProviderName,
    });
  },
});
```

### 4. Configure time-series storage policy (optional)

By default, the component behaves exactly as before: all raw time-series points are stored indefinitely.

If you want to reduce row growth for dense series like Garmin heart rate, persist a tier-based policy once from your app:

```ts
// convex/adminWearables.ts
import { mutation } from "./_generated/server";
import { wearables } from "./wearables";

export const configureWearablesStorage = mutation({
  args: {},
  handler: async (ctx) => {
    await wearables.replaceTimeSeriesPolicyConfiguration(ctx, {
      defaultRules: [
        // Global fallback: keep sparse metrics fully raw forever.
        {
          tiers: [{ kind: "raw", fromAge: "0m", toAge: null }],
        },
        // Garmin heart rate: raw for 24h, 30-minute rollups until day 7, then 3-hour rollups.
        {
          provider: "garmin",
          seriesType: "heart_rate",
          tiers: [
            { kind: "raw", fromAge: "0m", toAge: "24h" },
            { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
            { kind: "rollup", fromAge: "7d", toAge: null, bucket: "3h" },
          ],
        },
        // Lower-value dense signals can skip raw storage entirely.
        {
          provider: "garmin",
          seriesType: "oxygen_saturation",
          tiers: [
            {
              kind: "rollup",
              fromAge: "0m",
              toAge: null,
              bucket: "5m",
              aggregations: ["avg", "min", "max", "last", "count"],
            },
          ],
        },
      ],
      presets: [
        {
          key: "pro",
          rules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "7d" },
                { kind: "rollup", fromAge: "7d", toAge: null, bucket: "1h" },
              ],
            },
          ],
        },
      ],
      maintenance: {
        enabled: true,
        interval: "1h",
      },
    });

    await wearables.setUserTimeSeriesPolicyPreset(ctx, {
      userId: "pro-user-123",
      presetKey: "pro",
    });
  },
});
```

Those rules are stored inside the component and then used automatically by manual syncs, cron syncs, Garmin webhooks, and SDK push ingestion.

## API Reference

### `WearablesClient`

The main API surface. Instantiate once with your component reference and provider credentials.

```ts
const wearables = new WearablesClient(components.wearables, config);
```

#### Connection Management

| Method | Description |
|--------|-------------|
| `getConnections(ctx, { userId })` | Get all connections for a user (tokens stripped) |
| `getConnection(ctx, { userId, provider })` | Get a specific provider connection |
| `getSyncStatus(ctx, { userId })` | Get sync status across all providers |
| `disconnect(ctx, { userId, provider })` | Disconnect a provider (clears tokens, sets inactive) |

#### Events (Workouts & Sleep)

| Method | Description |
|--------|-------------|
| `getEvents(ctx, { userId, category, startDate?, endDate?, limit?, cursor? })` | Paginated events query |
| `getEvent(ctx, { eventId })` | Get a single event by ID |
| `getWorkoutEnrichment(ctx, { eventId })` | Get normalized laps, splits, lengths, sets, and zones |
| `upsertWorkoutEnrichment(ctx, input)` | Replace normalized enrichment from a custom parser/provider |

The `category` parameter is `"workout"` or `"sleep"`. Results are ordered by start time (newest first). Pagination uses cursor-based tokens returned in `nextCursor`.

#### Time Series

| Method | Description |
|--------|-------------|
| `getTimeSeries(ctx, { userId, seriesType, startDate, endDate, limit? })` | Get time-series data points |
| `getLatestDataPoint(ctx, { userId, seriesType })` | Get the most recent value for a metric |
| `getAvailableSeriesTypes(ctx, { userId })` | List which metric types have data |
| `getTimeSeriesPolicyConfiguration(ctx)` | Read the persisted default rules, presets, and maintenance settings |
| `getUserTimeSeriesPolicyPreset(ctx, { userId })` | Read a user's assigned preset, if any |
| `getEffectiveTimeSeriesPolicy(ctx, { userId, provider, seriesType })` | Resolve the effective policy after preset assignment and default fallback |

See [Series Types](#series-types) for all 88 supported metrics.

When a query returns rollup-backed points, each point can also include:

- `resolution` — `"raw"` or `"rollup"`
- `bucketMinutes`
- `avg`, `min`, `max`, `last`, `count`

#### Daily Summaries

| Method | Description |
|--------|-------------|
| `getDailySummaries(ctx, { userId, provider?, category, startDate, endDate })` | Get daily aggregates, optionally scoped to one provider |

Categories: `"activity"`, `"sleep"`, `"recovery"`, `"body"`.

Daily summary rows are provider-aware. Multi-provider apps should pass
`provider` or apply their own canonical source precedence before showing totals;
omitting `provider` returns the storage rows across providers for the requested
category and date range.

#### Data Sources

| Method | Description |
|--------|-------------|
| `getOrCreateDataSource(ctx, { userId, provider, deviceModel?, source? })` | Get or create a data source |

#### Sync Control

| Method | Description |
|--------|-------------|
| `createSyncJob(ctx, { userId, provider? })` | Create a sync job record |
| `getSyncJobs(ctx, { userId, limit? })` | Get recent sync jobs |
| `syncAllActive(ctx, { syncWindowHours? })` | Trigger a sync across all active connections |

#### Synthetic provider

| Method | Description |
|--------|-------------|
| `isSyntheticProviderEnabled()` | Check whether userland enabled the integration |
| `seedSyntheticData(ctx, args)` | Generate a connected and synced `synthetic` provider data set |
| `getSyntheticDataStatus(ctx, { userId })` | Inspect its date range and normalized row counts |
| `clearSyntheticData(ctx, { userId })` | Idempotently remove the user's synthetic integration |

Enable the provider explicitly when constructing the client. Keep this setting
off in production userland:

```ts
const wearables = new WearablesClient(components.wearables, {
  providers: {
    synthetic: { enabled: process.env.ENABLE_SYNTHETIC_WEARABLES === "true" },
  },
});
```

Call it from an authenticated host mutation. The host chooses the user and owns
any admin/development authorization policy:

```ts
export const seedWearables = mutation({
  args: {
    userId: v.string(),
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, args) => {
    // Apply the host app's admin authorization here.
    return await wearables.seedSyntheticData(ctx, {
      ...args,
      timezone: "Europe/Madrid",
      profile: "mixed",
      asOf: Date.now(),
      replaceExisting: true,
    });
  },
});
```

The explicit range may cover up to 31 days and cannot end after the `asOf` day.
Generated events and time-series points never extend past `asOf`, which defaults
to generation time. Prior calendar days stay stable when a range grows.
`replaceExisting` atomically replaces that user's previous synthetic
integration. Use `profile: "sedentary"` for a deterministic partial-score UI
state. Use `profile: "showcase"` for a seeded physically active user: each
Monday-to-Sunday block contains four perfect target days, two days in the
80–90 range, and one day below 70 when scored against 3,500 steps, 350 active
calories, and seven hours of sleep. Garmin and other real connections coexist because generated rows use
`provider: "synthetic"`, with a normal connection and a `SynthDevice` data
source. The provider advertises generated-data capability but no OAuth, pull,
webhook, or backfill capability, so existing sync routing ignores it naturally.

The component namespace is also available directly as
`components.wearables.synthetic`. No HTTP endpoint is registered. Direct
component use bypasses the client's userland enablement check, so expose it only
through an authenticated host function with the same policy.

#### OAuth

| Method | Description |
|--------|-------------|
| `generateAuthUrl(ctx, { userId, provider, redirectUri })` | Build an OAuth URL using configured provider credentials |
| `handleCallback(ctx, { provider, state, code })` | Exchange a callback code and persist the resulting connection |

#### Lifecycle

| Method | Description |
|--------|-------------|
| `deleteAllUserData(ctx, { userId })` | Delete all data for a user (GDPR) |

#### Configuration

| Method | Description |
|--------|-------------|
| `getProviderCredentials(provider)` | Get credentials for a provider |
| `getConfiguredProviders()` | List all configured providers |
| `getProviderCapabilities(provider)` | Get static sync/delivery capabilities for one provider |
| `getProviderCapabilityInfo(provider)` | Get capabilities plus derived UI-friendly flags |
| `getAllProviderCapabilityInfo()` | Get capability info for every supported provider |
| `replaceTimeSeriesPolicyConfiguration(ctx, { defaultRules, presets?, maintenance? })` | Replace the persisted time-series policy configuration |
| `setUserTimeSeriesPolicyPreset(ctx, { userId, presetKey })` | Assign or clear a user-specific preset |

### Provider Capabilities

Provider capabilities are static metadata that describe how each provider delivers data.
They are additive client-side helpers; they do not change sync behavior or require a
schema migration.

```ts
import {
  getProviderCapabilityInfo,
  supportsBackfill,
  supportsManualSync,
} from "@clipin/convex-wearables";

const garmin = getProviderCapabilityInfo("garmin");
console.log(garmin.defaultLiveSyncMode); // "webhook"
console.log(supportsManualSync("garmin")); // false
console.log(supportsBackfill("garmin")); // true
```

Use these helpers in host apps to decide whether to show cloud sync, mobile SDK
sync, webhook status, or historical backfill controls without hardcoding provider
names in app UI.

## Time-Series Storage Policy

The storage policy is optional.

- If you do nothing, the built-in fallback is one raw tier from age `0` to `null`, which means raw points are stored indefinitely.
- Policies are persisted in Convex and applied centrally in the shared time-series write path.
- The same rules apply to workflow syncs, Garmin webhooks, and SDK push ingestion.
- Default rules are deployment-wide.
- Presets are optional and can be assigned per user.

### Precedence

Default rules are matched in this order:

1. exact `provider + seriesType`
2. `seriesType` across all providers
3. `provider` across all series
4. global policy
5. built-in fallback: raw forever

If a user has a preset assignment, matching starts inside that preset first and falls back to the default rules only when the preset does not define a rule for that provider/series pair.

### Tier model

Each rule is a list of contiguous tiers ordered by age:

- `fromAge: "0m"` means "newest data"
- age grows as data gets older
- `toAge: null` means "keep this tier forever"
- if no tier matches a point's age, that data is deleted

Two tier kinds are supported:

- `raw`: keep original data points
- `rollup`: keep bucketed aggregates such as `avg`, `min`, `max`, `last`, and `count`

Durations accept a numeric millisecond value or a compact string such as `30m`, `24h`, `7d`, or `2w`.

### Configuration shape

Each default rule or preset rule supports:

- `provider?`
- `seriesType?`
- `tiers`

Each tier supports:

- raw tier:
  - `kind: "raw"`
  - `fromAge`
  - `toAge`
- rollup tier:
  - `kind: "rollup"`
  - `fromAge`
  - `toAge`
  - `bucket`
  - `aggregations?`

Rollup aggregations default to `["avg", "min", "max", "last", "count"]`.

### Configuration reference

Use `replaceTimeSeriesPolicyConfiguration(ctx, { defaultRules, presets?, maintenance? })` to persist the policy model, and `setUserTimeSeriesPolicyPreset(ctx, { userId, presetKey })` to assign a preset to a specific user.

#### Top-level configuration

| Field | Type | Required | Description |
|---|---|---|---|
| `defaultRules` | `TimeSeriesPolicyRuleInput[]` | Yes | Deployment-wide fallback rules used for all users unless a preset match overrides them. |
| `presets` | `TimeSeriesPolicyPresetInput[]` | No | Named policy sets that can be assigned per user. |
| `maintenance.enabled` | `boolean` | No | Enables the internal maintenance loop. Defaults to `true`. |
| `maintenance.interval` | `string \| number` | No | How often the maintenance loop should run. Accepts compact duration strings like `1h` or a millisecond number. |

#### Rule fields

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `ProviderName` | No | Limits the rule to one provider. Omit for "all providers". |
| `seriesType` | `SeriesType \| string` | No | Limits the rule to one metric. Omit for "all series types". |
| `tiers` | `TimeSeriesTierInput[]` | Yes | Ordered list of age-based storage tiers. Must be contiguous from newest to oldest. |

Rules may be:

- global: no `provider`, no `seriesType`
- provider-only: `provider` only
- series-only: `seriesType` only
- exact: both `provider` and `seriesType`

#### `provider` values

Valid `provider` values are:

- `garmin`
- `suunto`
- `polar`
- `whoop`
- `strava`
- `apple`
- `samsung`
- `google`

Use `provider` only when you want different retention for the same metric depending on where it came from.

#### `seriesType` values

`seriesType` should be one of the supported metric keys from [`SERIES_TYPES`](#series-types).

Examples:

- `heart_rate`
- `resting_heart_rate`
- `oxygen_saturation`
- `steps`
- `weight`
- `respiratory_rate`
- `garmin_stress_level`

For full safety in your app code, use the exported `SeriesType` type or `SERIES_TYPES` constant:

```ts
import { SERIES_TYPES, type SeriesType } from "@clipin/convex-wearables";

const metric: SeriesType = "heart_rate";
const validKey = SERIES_TYPES.heart_rate;
```

If you omit `seriesType`, the rule applies to every supported metric for that scope.

#### Tier fields

| Field | Type | Required | Applies to | Description |
|---|---|---|---|---|
| `kind` | `"raw" \| "rollup"` | Yes | all tiers | Whether the tier stores original rows or bucketed aggregates. |
| `fromAge` | `string \| number` | Yes | all tiers | Lower age boundary for the tier. `0m` means newest data. |
| `toAge` | `string \| number \| null` | Yes | all tiers | Upper age boundary. `null` means open-ended / forever. |
| `bucket` | `string \| number` | Yes | rollup only | Bucket size for rollups. Must normalize to a whole number of minutes. |
| `aggregations` | `("avg" \| "min" \| "max" \| "last" \| "count")[]` | No | rollup only | Which summary values to keep for rollup rows. Defaults to all five. |

#### Duration values

All duration fields accept either:

- a compact string: `500ms`, `30s`, `15m`, `24h`, `7d`, `2w`
- a non-negative number interpreted as milliseconds

Examples:

- `fromAge: "0m"`
- `toAge: "24h"`
- `bucket: "30m"`
- `interval: "1h"`

#### Tier validation rules

The implementation currently enforces:

- the first tier must start at age `0`
- tiers must be contiguous with no gaps and no overlap
- open-ended tiers (`toAge: null`) must be the final tier
- only one raw tier is allowed in a single rule
- rollup buckets must be positive whole-minute durations

If data becomes older than the last tier, maintenance deletes it.

#### Aggregation values and meaning

| Aggregation | Meaning |
|---|---|
| `avg` | Arithmetic mean of all samples in the bucket |
| `min` | Lowest value seen in the bucket |
| `max` | Highest value seen in the bucket |
| `last` | Most recent value seen in the bucket |
| `count` | Number of samples combined into the bucket |

When querying rollup-backed data:

- the response always includes `value`
- `value` is selected from the configured aggregations using this priority: `avg`, then `last`, then `max`, then `min`, then `count`
- the rollup point also exposes `avg`, `min`, `max`, `last`, and `count` fields when available in storage

So if you configure:

```ts
aggregations: ["last"]
```

then `value` for that rollup point will be the bucket's `last` value.

#### Presets and per-user behavior

Each preset has:

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | `string` | Yes | Stable preset identifier such as `free`, `pro`, or `enterprise`. |
| `rules` | `TimeSeriesPolicyRuleInput[]` | Yes | Rules evaluated before the default rules for users assigned to that preset. |

User assignment behavior:

- assign a preset with `setUserTimeSeriesPolicyPreset({ userId, presetKey: "pro" })`
- clear a preset with `setUserTimeSeriesPolicyPreset({ userId, presetKey: null })`
- if a user's preset has no matching rule for a provider/series pair, evaluation falls back to `defaultRules`

This means per-user support is implemented as preset assignment, not as arbitrary custom rule blobs per user.

#### Practical examples

Keep raw data forever:

```ts
{
  tiers: [{ kind: "raw", fromAge: "0m", toAge: null }],
}
```

Keep raw 24h, then 30-minute rollups for 7 days, then delete:

```ts
{
  provider: "garmin",
  seriesType: "heart_rate",
  tiers: [
    { kind: "raw", fromAge: "0m", toAge: "24h" },
    { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
  ],
}
```

Keep no raw data, only 5-minute rollups forever:

```ts
{
  provider: "garmin",
  seriesType: "oxygen_saturation",
  tiers: [
    {
      kind: "rollup",
      fromAge: "0m",
      toAge: null,
      bucket: "5m",
      aggregations: ["avg", "last", "count"],
    },
  ],
}
```

### Maintenance

Scheduled maintenance is enabled by default.

- It compacts raw rows into rollups when they age out of a raw tier.
- It compacts finer rollups into coarser rollups when older tiers use larger buckets.
- It deletes data that falls outside the last configured tier.
- It is configured globally through `maintenance.enabled` and `maintenance.interval`.
- Set `maintenance.enabled: false` if you want to disable the background maintenance loop.

The maintenance loop is internal to the component. You do not need to add your own cron job.

### Example queries

```ts
// convex/wearablesAdmin.ts
import { query } from "./_generated/server";
import { wearables } from "./wearables";

export const getStoragePolicies = query({
  args: {},
  handler: async (ctx) => {
    const configuration = await wearables.getTimeSeriesPolicyConfiguration(ctx);
    const assignedPreset = await wearables.getUserTimeSeriesPolicyPreset(ctx, {
      userId: "user-123",
    });
    const effectiveHeartRatePolicy = await wearables.getEffectiveTimeSeriesPolicy(ctx, {
      userId: "user-123",
      provider: "garmin",
      seriesType: "heart_rate",
    });

    return { configuration, assignedPreset, effectiveHeartRatePolicy };
  },
});
```

### Read behavior

- Reads prefer the tier configured for the requested age range.
- If maintenance has not caught up yet, reads fall back to any available raw or rollup data for that range instead of returning empty history.
- `value` on a rollup-backed point is chosen from the configured aggregation preference, using this priority: `avg`, then `last`, then `max`, then `min`, then `count`.
- Rollup-backed points also include `avg`, `min`, `max`, `last`, and `count` in the response.

### Write and retention behavior

- New points are written straight into the tier that matches their age at ingest time.
- Historical backfills do not need to land in raw storage first.
- Maintenance keeps already-stored data aligned with the current policy over time.
- Disconnecting an integration stops future ingestion, but stored data still ages out according to the policy unless you explicitly purge it from your app.

## Data Model

### Tables

| Table | Description | Key Indexes |
|-------|-------------|-------------|
| `connections` | OAuth tokens + provider link per user | `by_user`, `by_user_provider`, `by_status` |
| `dataSources` | User + provider + device combinations | `by_user_provider`, `by_user_provider_device`, `by_connection` |
| `dataPoints` | Time-series health metrics | `by_source_type_time`, `by_source_time`, `by_type_time` |
| `timeSeriesRollups` | Bucketed historical time-series rollups | `by_source_type_bucket`, `by_source_type_bucket_size`, `by_source_bucket`, `by_type_bucket` |
| `events` | Workouts and sleep sessions | `by_user_category_time`, `by_external_id`, `by_source_start_end` |
| `workoutSegments` | Normalized laps, splits, lengths, and strength sets | `by_event_kind_index`, `by_user_provider` |
| `workoutZones` | Normalized heart-rate and power time-in-zone | `by_event_kind_zone`, `by_user_provider` |
| `garminActivityFileJobs` | Ephemeral Garmin FIT processing inbox | `by_connection_status`, `by_activity`, `by_event_external_id`, `by_expiry` |
| `dailySummaries` | Provider-aware daily aggregates | `by_user_provider_category_date`, `by_user_provider_date`, `by_user_category_date`, `by_user_date` |
| `syncJobs` | Sync workflow tracking | `by_user`, `by_user_provider`, `by_user_status`, `by_status` |
| `oauthStates` | Temporary OAuth PKCE state | `by_state` |
| `timeSeriesPolicyRules` | Persisted default rules and preset rules | `by_set`, `by_set_scope` |
| `timeSeriesPolicyAssignments` | Per-user preset assignment | `by_user`, `by_preset` |
| `timeSeriesPolicySettings` | Global maintenance settings | `by_key` |
| `timeSeriesSeriesState` | Per-source series maintenance cursor | `by_source_series`, `by_next_maintenance`, `by_user` |
| `backfillJobs` | Long-running historical data imports | `by_connection`, `by_status` |

### Deduplication

Events are deduplicated at two levels:

1. **By `externalId`** — provider-assigned IDs like `strava-12345` prevent duplicate imports
2. **By `dataSourceId` + `startDatetime` + `endDatetime`** — catches duplicates even without external IDs

This is same-provider replay protection, not cross-provider reconciliation. A
Garmin workout and a copy observed through Strava have different provider
identities and may both be stored. Host applications own canonical-source and
cross-provider duplicate policy; see
[Strava integration boundaries](./docs/strava-integration-boundaries.md).

Data points are deduplicated by `dataSourceId` + `seriesType` + `recordedAt`.

Rollups are upserted by `dataSourceId` + `seriesType` + `bucketMs` + `bucketStart`.

## OAuth Flow

The component handles the full OAuth 2.0 authorization code flow:

```
┌──────────┐    1. generateAuthUrl     ┌─────────────────┐
│  Your App │ ───────────────────────▶  │  Component       │
│           │ ◀──────────────────────── │  (stores state)  │
│           │    ← authorization URL    │                  │
└─────┬─────┘                           └─────────────────┘
      │ 2. redirect user to provider
      ▼
┌──────────┐    3. user authorizes     ┌─────────────────┐
│ Provider  │ ───────────────────────▶  │  Your App        │
│ (Strava)  │    ← redirect with code  │  /callback       │
└──────────┘                           └─────┬───────────┘
                                             │ 4. handleCallback
                                             ▼
                                       ┌─────────────────┐
                                       │  Component       │
                                       │  - exchange code │
                                       │  - store tokens  │
                                       │  - create conn   │
                                       └─────────────────┘
```

### Actions

| Action | Description |
|--------|-------------|
| `generateAuthUrl` | Build OAuth URL, store state with PKCE |
| `handleCallback` | Exchange code, fetch user info, create connection |
| `ensureValidToken` | Internal token refresh helper used by sync actions |

## Sync Workflow

The sync workflow runs as a Convex action:

1. **Token validation** — refreshes expired tokens automatically, revokes connections whose refresh token is definitively rejected, and leaves transient provider failures retryable
2. **Data fetch** — calls provider API with pagination (e.g., 200 activities per page from Strava)
3. **Batch storage** — writes events in batches of 50 to stay within Convex's 1-second mutation timeout
4. **Status tracking** — creates sync job records with status, timestamps, and error details

Pull providers can re-fetch a trailing window so late provider revisions are not
missed. Configure a global overlap or provider-specific values when constructing
the client:

```ts
const wearables = new WearablesClient(components.wearables, {
  providers: {
    strava: { clientId: "...", clientSecret: "..." },
    whoop: { clientId: "...", clientSecret: "..." },
  },
  pullSyncLookbackHours: {
    strava: 6,
    whoop: 24,
  },
});
```

Lookback is disabled by default to preserve existing provider API usage. It is
subtracted from `lastSyncedAt` and capped by `syncWindowHours`. An explicit
`startDate` always wins. Individual calls can override the configured value with
`lookbackHours`.

### Cron-based sync

Set up a Convex cron to sync all active connections periodically:

```ts
// convex/crons.ts
import { cronJobs } from "convex/server";
import { components } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "sync all wearables",
  { minutes: 15 },
  components.wearables.syncWorkflow.syncAllActive,
  {
    clientCredentials: {
      strava: {
        clientId: process.env.STRAVA_CLIENT_ID!,
        clientSecret: process.env.STRAVA_CLIENT_SECRET!,
      },
    },
    syncWindowHours: 24,
  },
);

export default crons;
```

## Webhook Support

### Garmin Webhooks

Register Garmin routes directly from the package:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { registerRoutes } from "@clipin/convex-wearables";
import { components } from "./_generated/api";

const http = httpRouter();

registerRoutes(http, components.wearables, {
  garmin: {
    clientId: process.env.GARMIN_CLIENT_ID,
    clientSecret: process.env.GARMIN_CLIENT_SECRET,
    oauthCallbackPath: "/oauth/garmin/callback",
    successRedirectUrl: process.env.NEXT_PUBLIC_APP_URL,
    webhookPath: "/webhooks/garmin/push",
    healthPath: "/webhooks/garmin/health",
    activityFiles: {
      enabled: true,
      // Optional; defaults to 20 MiB and Garmin API hosts only.
      maxBytes: 20 * 1024 * 1024,
    },
  },
});

export default http;
```

The Garmin route helper:

- handles the Garmin OAuth callback redirect
- validates the `garmin-client-id` header
- logs payload summaries and processing errors
- forwards the payload to `components.wearables.garminWebhooks.processPushPayload`
- exposes an optional health-check route
- optionally queues Garmin FIT Activity Files for asynchronous workout enrichment

Activity File processing is disabled by default. When enabled, callback URLs
must use HTTPS and an allowed Garmin host, redirects are rejected, downloads
are size- and time-bounded, and callback URLs are scrubbed after use or expiry.
Raw FIT bytes are parsed in memory and are never retained. Summary workouts
remain available even if enrichment fails.

Garmin `activityDetails` samples are always normalized into the existing
time-series store. FIT samples for a series already present in
`activityDetails` are skipped to avoid same-workout duplication. Read deep
detail with `wearables.getWorkoutEnrichment(ctx, { eventId })`; read samples
with the normal `getTimeSeries` API and configure their lifecycle through the
existing time-series storage policies.

If you customize `oauthCallbackPath`, the redirect URI used when calling
`oauthActions.generateAuthUrl` must match that same callback path.

### WHOOP v2, Polar, and Suunto live webhooks

Version `0.11.0` adds opt-in, receipt-first inbound callbacks for WHOOP v2,
Polar AccessLink, and Suunto. They complement scheduled pull sync; they do not
replace reconciliation. Mount only the providers you intend to enable:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { registerRoutes } from "@clipin/convex-wearables";
import { components } from "./_generated/api";

const http = httpRouter();

registerRoutes(http, components.wearables, {
  garmin: false, // omit this only if Garmin routes are not needed
  providerWebhooks: {
    whoop: { path: "/wearables/webhooks/whoop/v2" },
    polar: { path: "/wearables/webhooks/polar" },
    suunto: { path: "/wearables/webhooks/suunto" },
  },
});

export default http;
```

No live-provider route is mounted unless `providerWebhooks` and that provider
key are both present. The request path reads at most 512,000 bytes by default,
verifies the signature over the exact body, validates the notification, and
transactionally stores/deduplicates a receipt while starting a dedicated
Workflow. Targeted provider fetches, inline sample normalization, deletes, and
retries run after acknowledgement with an isolated five-action concurrency
budget and four-attempt exponential retry policy.

Configure WHOOP's callback URL in its developer dashboard. WHOOP uses the
provider `clientSecret` already configured for OAuth and accepts only v2 UUID
resource notifications. Record safe local status explicitly:

```ts
await wearables.configureProviderWebhook(ctx, {
  provider: "whoop",
  targetUrl: `${convexSiteUrl}/wearables/webhooks/whoop/v2`,
  eventTypes: [
    "workout.updated",
    "workout.deleted",
    "sleep.updated",
    "sleep.deleted",
    "recovery.updated",
    "recovery.deleted",
  ],
});
```

Configure Suunto's callback and notification secret in API Zone, then store the
same secret through an operator-authorized wrapper:

```ts
await wearables.configureProviderWebhook(ctx, {
  provider: "suunto",
  targetUrl: `${convexSiteUrl}/wearables/webhooks/suunto`,
  webhookSecret: process.env.SUUNTO_WEBHOOK_SECRET,
  eventTypes: [
    "WORKOUT_CREATED",
    "SUUNTO_247_SLEEP_CREATED",
    "SUUNTO_247_ACTIVITY_CREATED",
    "SUUNTO_247_RECOVERY_CREATED",
  ],
});
```

Polar registration is component-managed because Polar permits one callback per
API client and returns its signing secret only once:

```ts
await wearables.createPolarWebhook(ctx, {
  targetUrl: `${convexSiteUrl}/wearables/webhooks/polar`,
  eventTypes: ["EXERCISE"],
});
```

This release intentionally subscribes only to Polar `EXERCISE`, the event with
a complete targeted normalization path. Use `updatePolarWebhook`,
`activatePolarWebhook`, `deactivatePolarWebhook`, `deletePolarWebhook`, and
`reconcilePolarWebhookRegistration` from operator-authorized actions. If
reconciliation reports `signing_secret_missing_recreate_required`, delete the
remote registration and recreate it; Polar cannot reveal the old secret.

Receipt and registration APIs are deliberately authorization-agnostic. Wrap
them with your host's operator/tenant authorization before exposing them:

```ts
await wearables.getProviderWebhookStatus(ctx, { provider: "whoop" });
await wearables.listProviderWebhookReceipts(ctx, {
  provider: "whoop",
  status: "failed",
  limit: 20,
});
await wearables.retryProviderWebhookReceipt(ctx, { receiptId });
await wearables.cancelProviderWebhookReceipt(ctx, { receiptId });
```

Public status never returns raw payloads or signing secrets. Successful and
ignored payloads are redacted immediately; failed payloads are retained only
within the seven-day receipt window. Unknown connections get a bounded
15-minute OAuth race window. Provider/user deletion cancels and removes
resolved receipts, and the normal ingestion fence prevents late writes.

Keep scheduled pulls enabled for WHOOP, Polar, and Suunto. Webhooks are
at-least-once signals: duplicates are harmless, but providers can still omit or
reorder them. Incoming provider webhooks are unrelated to the planned outgoing
consumer webhook feature.

### Durable outgoing events and self-service webhooks

Version `0.12.0` adds an opt-in transactional event stream for host callbacks
and signed external subscriptions. This is distinct from provider webhooks:
provider callbacks ingest wearable data, while outgoing webhooks notify systems
after normalized component data commits.

Nothing is captured or delivered until a host enables it. First persist the
host-authorized tenant membership used by transactional writes:

```ts
await wearables.setWebhookUserTenant(ctx, {
  userId: authenticatedUserId,
  tenantId: authorizedTenantId,
});

await wearables.configureOutgoingWebhooks(ctx, {
  captureEnabled: true,
  externalDeliveryEnabled: false,
});
```

For a typed internal callback, create a Convex function handle for a mutation
or action accepting `WearablesEventEnvelope`, then pass that handle to
`configureOutgoingWebhooks` with its function kind:

```ts
await wearables.configureOutgoingWebhooks(ctx, {
  captureEnabled: true,
  internalCallbackHandle: callbackHandle,
  internalCallbackKind: "mutation", // or "action"
});
```

Callback errors are isolated from ingestion and retried four times with
exponential backoff in the outgoing-webhook Workflow pool. External endpoint
fan-out is committed before the callback runs, so exhausting callback retries
cannot suppress external delivery. `onDataSynced` remains supported.

External delivery additionally requires a deployment secret:

```bash
openssl rand -base64 32
npx convex env set CONVEX_WEARABLES_WEBHOOK_ENCRYPTION_KEY '<base64-key>'
```

Enable delivery only after that key is present. Endpoint and configuration
methods do not authenticate callers; expose them through host functions that
verify tenant administration or exact user ownership:

```ts
await wearables.configureOutgoingWebhooks(ctx, {
  captureEnabled: true,
  externalDeliveryEnabled: true,
});

const created = await wearables.createWebhookEndpoint(ctx, {
  tenantId: authorizedTenantId,
  scope: "user",
  userId: authenticatedUserId,
  url: "https://receiver.example/webhooks/wearables",
  eventTypes: ["workout.*", "sleep.*"],
  payloadMode: "reference",
});
// Display created.signingSecret once; ordinary queries never return it.

await wearables.verifyWebhookEndpoint(ctx, {
  tenantId: authorizedTenantId,
  endpointId: created.endpointId,
});
```

Group selectors expand to the exact catalog at save time, so future sensitive
events do not silently enter existing subscriptions. Reference payloads are
the default. Snapshot mode requires both global and per-endpoint opt-in and
still excludes routes/GPS, menstrual data, raw sleep stages, credentials,
provider payloads, and files. Fan-out stores the endpoint-specific canonical
body, so retries keep identical bytes after later endpoint configuration
changes. Snapshot bodies are not retained before the global opt-in is enabled.

Every delivery uses the immutable canonical event body and these headers:

```text
wearables-id: <stable event id>
wearables-timestamp: <unix seconds>
wearables-signature: v1,<base64 hmac-sha256>
wearables-attempt: <1-based attempt>
wearables-event-type: <event type>
```

Verify `HMAC-SHA256(secret, "<id>.<timestamp>.<rawBody>")` against the exact
bytes using constant-time comparison and reject timestamps outside five
minutes. Delivery is at least once and unordered; receivers must persist the
event ID before non-idempotent work.

External POSTs are HTTPS-only, redirect-free, limited to port 443, and use a
public DNS result pinned into the TLS connection. Local, private, link-local,
reserved, multicast, credentialed, and fragment URLs fail closed. Requests
time out after 15 seconds. Failures follow the eight-attempt schedule of
immediate, 5 seconds, 5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, and
10 hours. HTTP 410 and `webhook-delivery: abort-message` are terminal.

Every delivery claim receives a unique two-minute lease token and schedules a
durable watchdog in the same mutation. The network action renews that lease
when it actually starts, preventing Workpool queue time from consuming the
request window. Normal completion makes both watchdogs no-ops. If an action is
interrupted before recording its result, the watchdog
records a bounded `worker_interrupted` attempt and durably schedules the next
Workflow according to the normal retry policy. A late result from the abandoned
worker cannot update the reissued delivery because its lease token no longer
matches. The receiver may still observe the stable event more than once, so
receiver-side event-ID deduplication remains required.

Use the endpoint/event/delivery/attempt list methods for safe status, and
`retryWebhookDelivery`, `recoverFailedWebhookDeliveries`, or
`replayMissingWebhookEvents` for explicit recovery. Bulk recovery and replay
return a durable operation ID whose progress is available through
`getWebhookRecoveryOperation`. Payloads are retained up to 30 days, successful
attempts seven days, and failed attempts 30 days. Provider/user deletion
cancels and removes matching queued health payloads; tenant-wide endpoint
configuration survives deletion of one user.

To rotate the deployment master key, temporarily set the old key as
`CONVEX_WEARABLES_WEBHOOK_PREVIOUS_ENCRYPTION_KEY`, install the new current
key, call `rewrapWebhookEndpointSecret` for every endpoint, verify delivery,
then remove the previous key. Losing all configured decryption keys requires
receiver-secret rotation.

### Strava Webhooks

The component provides HTTP handlers for Strava's [webhook events API](https://developers.strava.com/docs/webhooks/):

| Endpoint | Handler | Purpose |
|----------|---------|---------|
| `GET /webhooks/strava` | `stravaWebhookVerify` | Subscription verification (hub.challenge) |
| `POST /webhooks/strava` | `stravaWebhookEvent` | Receive activity create/update/delete events |

Mount these in your Convex HTTP router:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { stravaWebhookVerify, stravaWebhookEvent } from "@clipin/convex-wearables";

const http = httpRouter();

http.route({
  path: "/webhooks/strava",
  method: "GET",
  handler: stravaWebhookVerify,
});

http.route({
  path: "/webhooks/strava",
  method: "POST",
  handler: stravaWebhookEvent,
});

export default http;
```

Set `STRAVA_WEBHOOK_VERIFY_TOKEN` in the host Convex deployment to the same
secret used when creating the Strava webhook subscription. Verification fails
closed with HTTP 403 when the secret is missing or does not match; the token is
never logged.

### SDK Push (Apple Health / Google Health Connect)

For on-device providers, register the normalized SDK sync route explicitly:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { getSdkSyncUrl, registerRoutes } from "@clipin/convex-wearables";
import { components } from "./_generated/api";

const http = httpRouter();

const routeConfig = {
  sdk: {
    syncPath: "/sdk/sync",
    authToken: process.env.WEARABLES_SDK_AUTH_TOKEN,
  },
};

registerRoutes(http, components.wearables, routeConfig);

const sdkSyncUrl = getSdkSyncUrl(process.env.CONVEX_SITE_URL!, routeConfig);

export default http;
```

The same configuration also registers `/sdk/sync/v2`, a resilient opt-in route
that accepts a versioned envelope:

```ts
const result = await fetch(`${process.env.CONVEX_SITE_URL}/sdk/sync/v2`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${sdkToken}`,
  },
  body: JSON.stringify({
    userId: "user_123",
    provider: "google",
    requestId: "health-connect-sync-2026-08-01T08:00:00Z",
    mode: "partial",
    payload: {
      dataPoints: normalizedPoints,
      events: normalizedEvents,
      summaries: normalizedSummaries,
    },
  }),
});

const report = await result.json();
```

V2 stores valid rows when isolated rows are malformed and reports bounded,
privacy-safe rejection codes. Set `mode: "strict"` to preserve request-level
all-or-nothing validation. The original `/sdk/sync` route is unchanged. Set
`syncV2Path: false` to disable v2 or provide a custom path.

Then POST a pre-normalized payload from your mobile app:

```json
{
  "userId": "user_123",
  "provider": "google",
  "sourceMetadata": {
    "deviceModel": "Pixel Watch 3",
    "source": "health-connect"
  },
  "events": [],
  "dataPoints": [
    {
      "seriesType": "heart_rate",
      "recordedAt": 1773817200000,
      "value": 58
    }
  ],
  "summaries": []
}
```

The backend stores the payload using the same `connections`, `dataSources`, `events`, `dataPoints`, and `dailySummaries` tables as the cloud providers.
Daily summaries are keyed by user, provider, category, and date, so Apple Health,
Google Health Connect, Garmin, and other providers can coexist without
overwriting each other's aggregate rows.

The SDK payload also accepts `device` and `dailySummaries` as compatibility aliases, and normalizes common Health Connect metric names like `hrv_rmssd`.

## Supported Providers

| Provider | Integration mode | Current support | Status |
|----------|------------------|-----------------|--------|
| Strava | OAuth pull sync + webhook-triggered resync | Workouts, connection lifecycle, sync jobs | Implemented |
| Garmin | OAuth connection + push webhooks + durable backfill | Workouts, sleep, time-series, summaries | Implemented |
| Apple Health | Normalized SDK push | Workouts, sleep, time-series, summaries from your mobile app | Implemented via SDK |
| Samsung Health | Normalized SDK push | Workouts, sleep, time-series, summaries from your mobile app | Implemented via SDK |
| Google Health Connect | Normalized SDK push | Workouts, sleep, time-series, summaries from your mobile app | Implemented via SDK |
| Whoop | OAuth pull + signed v2 targeted-fetch webhooks | Workouts, sleep, recovery, body data | Implemented |
| Polar | OAuth pull + signed targeted-fetch webhooks | Workouts; live `EXERCISE` | Implemented |
| Suunto | OAuth pull + signed inline/targeted webhooks | Workouts, sleep, recovery, activity data | Implemented |
| Synthetic | Deterministic local generation | Workouts, sleep, time-series, summaries through `SynthDevice` | Implemented; explicit opt-in |

SDK-push providers rely on your app to send normalized payloads. The component stores and queries that data, but it does not yet fetch Apple Health, Samsung Health, or Google Health Connect data directly from vendor APIs.

### Adding a Provider

Implement the `ProviderDefinition` interface and register it in the provider registry:

```ts
// src/component/providers/garmin.ts
import type { ProviderDefinition } from "./registry";

export const garminProvider: ProviderDefinition = {
  oauthConfig(clientId, clientSecret) {
    return {
      endpoints: {
        authorizeUrl: "https://connect.garmin.com/oauthConfirm",
        tokenUrl: "https://connectapi.garmin.com/oauth-service/oauth/token",
        apiBaseUrl: "https://apis.garmin.com",
      },
      clientId,
      clientSecret,
      defaultScope: "",
      usePkce: false,
      authMethod: "body",
    };
  },
  async fetchWorkouts(accessToken, startDate, endDate) {
    // Fetch and normalize activities...
    return [];
  },
  async getUserInfo(accessToken) {
    // Fetch user profile...
    return { providerUserId: null, username: null };
  },
};
```

### Workout Type Taxonomy

The component normalizes provider-specific activity types to a unified taxonomy:

| Unified Type | Strava Types |
|---|---|
| `running` | Run, VirtualRun |
| `trail_running` | TrailRun |
| `cycling` | Ride, GravelRide |
| `mountain_biking` | MountainBikeRide |
| `indoor_cycling` | VirtualRide |
| `swimming` | Swim |
| `hiking` | Hike |
| `walking` | Walk |
| `strength_training` | WeightTraining |
| `yoga` | Yoga |
| `alpine_skiing` | AlpineSki |
| `rowing` | Rowing |
| `kayaking` | Kayaking |
| `surfing` | Surfing |
| `rock_climbing` | RockClimbing |
| `golf` | Golf |
| `pickleball` | Pickleball |
| `tennis` | Tennis |
| `soccer` | Soccer |
| ... | (40+ types total) |

## Series Types

All 88 pre-defined metric types are available via the `SERIES_TYPES` constant:

Use these keys as `seriesType` values in time-series policy rules.

```ts
import { SERIES_TYPES } from "@clipin/convex-wearables/types";

console.log(SERIES_TYPES.heart_rate);
// { id: 1, unit: "bpm" }
```

<details>
<summary>Full list of series types</summary>

**Heart & Cardiovascular**: `heart_rate`, `resting_heart_rate`, `heart_rate_variability_sdnn`, `heart_rate_variability_rmssd`, `heart_rate_recovery_one_minute`, `walking_heart_rate_average`, `recovery_score`

**Blood & Respiratory**: `oxygen_saturation`, `blood_glucose`, `blood_pressure_systolic`, `blood_pressure_diastolic`, `respiratory_rate`, `sleeping_breathing_disturbances`, `blood_alcohol_content`, `peripheral_perfusion_index`, `forced_vital_capacity`, `forced_expiratory_volume_1`, `peak_expiratory_flow_rate`

**Body Composition**: `height`, `weight`, `body_fat_percentage`, `body_mass_index`, `lean_body_mass`, `body_temperature`, `skin_temperature`, `waist_circumference`, `body_fat_mass`, `skeletal_muscle_mass`

**Fitness**: `vo2_max`, `six_minute_walk_test_distance`

**Activity — Basic**: `steps`, `energy`, `basal_energy`, `stand_time`, `exercise_time`, `physical_effort`, `flights_climbed`, `average_met`

**Activity — Distance**: `distance_walking_running`, `distance_cycling`, `distance_swimming`, `distance_downhill_snow_sports`, `distance_other`

**Activity — Walking/Running/Swimming**: `walking_step_length`, `walking_speed`, `running_power`, `running_speed`, `running_stride_length`, `swimming_stroke_count`, `underwater_depth`, and more

**Environmental**: `environmental_audio_exposure`, `headphone_audio_exposure`, `time_in_daylight`, `water_temperature`, `uv_exposure`, `weather_temperature`, `weather_humidity`

**Garmin-specific**: `garmin_stress_level`, `garmin_skin_temperature`, `garmin_fitness_age`, `garmin_body_battery`

</details>

## Testing

The package test suite covers component internals, provider adapters, webhook
ingestion, strict and resilient SDK push ingestion, workflow orchestration, and
client helpers.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run src/component/events.test.ts
```

Coverage includes:

- `convex-test` suites for schema/index behavior, deduplication, data isolation, and sync job lifecycle
- webhook and ingestion flows for Garmin push payloads and normalized mobile SDK payloads
- provider adapter normalization for Strava plus additional provider config coverage
- workflow orchestration and client helpers such as route registration and SDK sync URL generation

## Platform Considerations

This component is designed around Convex's platform constraints:

| Constraint | Limit | How we handle it |
|---|---|---|
| Mutation timeout | 1 second | Batch writes (50 events per mutation) |
| Document scan limit | 32K per query | Cursor-based pagination, precomputed daily summaries |
| Action timeout | 10 minutes | Paginated provider API calls, sync-per-connection |
| Document size | 1 MiB | Flat event schema, sleep stages as embedded array |

For high-volume time-series data (e.g., per-second heart rate), consider using [`@convex-dev/aggregate`](https://github.com/get-convex/aggregate) for O(log n) sum/count/avg queries alongside this component.

## Project Structure

```
convex-wearables/
├── src/
│   ├── client/
│   │   ├── index.ts          # WearablesClient and HTTP route helper exports
│   │   └── types.ts          # Shared types and SERIES_TYPES
│   └── component/
│       ├── schema.ts         # Convex schema
│       ├── connections.ts    # Connection lifecycle queries and mutations
│       ├── events.ts         # Workout and sleep storage/query APIs
│       ├── dataPoints.ts     # Time-series storage/query APIs
│       ├── dataSources.ts    # Provider/device source tracking
│       ├── summaries.ts      # Daily aggregates
│       ├── syncJobs.ts       # Sync job tracking
│       ├── syncWorkflow.ts   # Durable per-connection sync orchestration
│       ├── garminWebhooks.ts # Garmin push ingestion
│       ├── sdkPush.ts        # Normalized mobile SDK ingestion
│       ├── garminBackfill.ts # Garmin historical backfill workflow
│       ├── httpHandlers.ts   # Standalone HTTP action handlers
│       ├── oauthActions.ts   # OAuth URL generation and callback handling
│       ├── providerSettings.ts # Stored provider credentials
│       ├── lifecycle.ts      # GDPR user data deletion
│       ├── convex.config.ts  # Component config
│       ├── providers/
│       │   ├── types.ts      # Provider interfaces
│       │   ├── oauth.ts      # Shared OAuth utilities
│       │   ├── garmin.ts     # Garmin adapter and normalization
│       │   ├── strava.ts     # Strava adapter and normalization
│       │   └── registry.ts   # Provider registry
│       └── *.test.ts         # Component and adapter tests
├── package.json
├── tsconfig.json
└── README.md
```

## License

Apache-2.0
