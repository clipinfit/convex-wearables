# @clipin/convex-wearables

[![Convex Component](https://www.convex.dev/components/badge/clipin/convex-wearables)](https://www.convex.dev/components/clipin/convex-wearables)

A [Convex component](https://docs.convex.dev/components) for wearable device integrations. Sync health data from **Garmin, Strava, Whoop, Polar, Suunto, Apple HealthKit, Samsung Health, and Google Health Connect** into your Convex app.

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
- **GDPR-ready** — cascading user data deletion in a single call
- **Webhook + SDK push support** — Garmin webhooks plus normalized mobile SDK ingestion for Apple Health / Google Health Connect
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
| `getDailySummaries(ctx, { userId, category, startDate, endDate })` | Get daily aggregates |

Categories: `"activity"`, `"sleep"`, `"recovery"`, `"body"`.

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
| `replaceTimeSeriesPolicyConfiguration(ctx, { defaultRules, presets?, maintenance? })` | Replace the persisted time-series policy configuration |
| `setUserTimeSeriesPolicyPreset(ctx, { userId, presetKey })` | Assign or clear a user-specific preset |

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
| `dataPoints` | Time-series health metrics | `by_source_type_time`, `by_type_time` |
| `timeSeriesRollups` | Bucketed historical time-series rollups | `by_source_type_bucket`, `by_source_type_bucket_size`, `by_source_bucket`, `by_type_bucket` |
| `events` | Workouts and sleep sessions | `by_user_category_time`, `by_external_id`, `by_source_start_end` |
| `dailySummaries` | Precomputed daily aggregates | `by_user_category_date`, `by_user_date` |
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

1. **Token validation** — refreshes expired tokens automatically
2. **Data fetch** — calls provider API with pagination (e.g., 200 activities per page from Strava)
3. **Batch storage** — writes events in batches of 50 to stay within Convex's 1-second mutation timeout
4. **Status tracking** — creates sync job records with status, timestamps, and error details

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

If you customize `oauthCallbackPath`, the redirect URI used when calling
`oauthActions.generateAuthUrl` must match that same callback path.

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

The SDK payload also accepts `device` and `dailySummaries` as compatibility aliases, and normalizes common Health Connect metric names like `hrv_rmssd`.

## Supported Providers

| Provider | Integration mode | Current support | Status |
|----------|------------------|-----------------|--------|
| Strava | OAuth pull sync + webhook-triggered resync | Workouts, connection lifecycle, sync jobs | Implemented |
| Garmin | OAuth pull sync + push webhooks + durable backfill | Workouts, sleep, time-series, summaries | Implemented |
| Apple Health | Normalized SDK push | Workouts, sleep, time-series, summaries from your mobile app | Implemented via SDK |
| Samsung Health | Normalized SDK push | Workouts, sleep, time-series, summaries from your mobile app | Implemented via SDK |
| Google Health Connect | Normalized SDK push | Workouts, sleep, time-series, summaries from your mobile app | Implemented via SDK |
| Whoop | Provider scaffolding | Not yet wired to data sync | Planned |
| Polar | Provider scaffolding | Not yet wired to data sync | Planned |
| Suunto | Provider scaffolding | Not yet wired to data sync | Planned |

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

The package currently has 110 passing tests across the component internals, provider adapters, webhook ingestion, SDK push ingestion, workflow orchestration, and client helpers.

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
