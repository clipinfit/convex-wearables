# @clipin/convex-wearables

A [Convex component](https://docs.convex.dev/components) for wearable device integrations. Sync health data from **Garmin, Strava, Whoop, Polar, Suunto, Apple HealthKit, Samsung Health, and Google Health Connect** into your Convex app.

Built as a drop-in module: install the component, pass your provider credentials, and start querying workouts, sleep sessions, heart rate, and 48+ health metrics — all in TypeScript, no backend glue code required.

## Features

- **OAuth 2.0 flows** with PKCE support — authorize users, exchange tokens, auto-refresh
- **Automatic sync** — cron-triggered or on-demand data fetching from provider APIs
- **Normalized data model** — workouts, sleep, time-series metrics, and daily summaries in a unified schema
- **40+ workout types** mapped to a unified taxonomy (running, cycling, swimming, yoga, etc.)
- **48 pre-defined metric types** — heart rate, HRV, SpO2, steps, weight, body temperature, and more
- **Cursor-based pagination** — efficient data access within Convex's scan limits
- **Deduplication** — events and data points are deduped by external ID and source+timestamp
- **Precomputed daily summaries** — activity, sleep, recovery, and body composition aggregates
- **GDPR-ready** — cascading user data deletion in a single call
- **Webhook + SDK push support** — Garmin webhooks plus normalized mobile SDK ingestion for Apple Health / Google Health Connect
- **Full TypeScript** — end-to-end type safety from provider API to client query

## Installation

```bash
npm install @clipin/convex-wearables convex
```

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
import { WearablesClient } from "@clipin/convex-wearables";
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
      provider: args.provider as any,
    });
  },
});
```

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

See [Series Types](#series-types) for all 48 supported metrics.

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

## Data Model

### Tables

| Table | Description | Key Indexes |
|-------|-------------|-------------|
| `connections` | OAuth tokens + provider link per user | `by_user`, `by_user_provider`, `by_status` |
| `dataSources` | User + provider + device combinations | `by_user_provider`, `by_user_provider_device`, `by_connection` |
| `dataPoints` | Time-series health metrics | `by_source_type_time`, `by_type_time` |
| `events` | Workouts and sleep sessions | `by_user_category_time`, `by_external_id`, `by_source_start_end` |
| `dailySummaries` | Precomputed daily aggregates | `by_user_category_date`, `by_user_date` |
| `syncJobs` | Sync workflow tracking | `by_user`, `by_user_provider`, `by_user_status`, `by_status` |
| `oauthStates` | Temporary OAuth PKCE state | `by_state` |
| `backfillJobs` | Long-running historical data imports | `by_connection`, `by_status` |

### Deduplication

Events are deduplicated at two levels:

1. **By `externalId`** — provider-assigned IDs like `strava-12345` prevent duplicate imports
2. **By `dataSourceId` + `startDatetime` + `endDatetime`** — catches duplicates even without external IDs

Data points are deduplicated by `dataSourceId` + `seriesType` + `recordedAt`.

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

| Provider | OAuth | Workouts | Sleep | Time-Series | Webhooks | Status |
|----------|-------|----------|-------|-------------|----------|--------|
| Strava | Body auth | 40+ types | - | - | Activity push | Implemented |
| Garmin | Body auth | 40+ types | Yes | 48+ metrics | Push API | Implemented |
| Whoop | Basic auth | Planned | Planned | Planned | Webhooks | Planned |
| Polar | PKCE | Planned | Planned | Planned | Webhooks | Planned |
| Suunto | PKCE + key | Planned | Planned | Planned | - | Planned |
| Apple | SDK push | Planned | Planned | Planned | - | Planned |
| Samsung | SDK push | Planned | Planned | Planned | - | Planned |
| Google | SDK push | Planned | Planned | Planned | - | Planned |

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

All 48 pre-defined metric types are available via the `SERIES_TYPES` constant:

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

The component has 80 tests across 10 test files covering the full data pipeline.

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run src/component/events.test.ts
```

### Test architecture

Tests use two approaches:

- **DB/schema tests** (`convex-test`) — verify tables, indexes, query patterns, deduplication, and business logic using `t.run(async (ctx) => { ctx.db... })` for direct database operations
- **Pure function tests** (vitest) — test OAuth URL building, PKCE generation, Strava activity normalization, workout type mapping, and energy unit conversion

| Test file | Tests | Coverage |
|-----------|-------|----------|
| `events.test.ts` | 9 | CRUD, dedup (externalId + source+start+end), pagination, filtering, isolation |
| `dataPoints.test.ts` | 8 | Store/retrieve, dedup, date range, pagination, series types, batch |
| `connections.test.ts` | 7 | Create, re-activate, index queries, disconnect |
| `summaries.test.ts` | 6 | Create, upsert, date range, category separation |
| `dataSources.test.ts` | 8 | Create, indexes, upsert, multi-device, by_connection, delete |
| `syncJobs.test.ts` | 7 | Create, status transitions, errors, index queries |
| `oauthStates.test.ts` | 7 | Store/retrieve, PKCE fields, consume, cleanup |
| `lifecycle.test.ts` | 2 | Cascading delete, user isolation |
| `strava.test.ts` | 14 | Type mapping, timestamps, HR/speed/elevation/power, energy conversion |
| `oauth.test.ts` | 12 | Random string, PKCE challenge, URL building, Strava config |

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
│   │   ├── index.ts          # WearablesClient — main API surface
│   │   └── types.ts           # Shared types, SERIES_TYPES
│   └── component/
│       ├── schema.ts          # Convex schema (10 tables)
│       ├── connections.ts     # Connection management queries/mutations
│       ├── events.ts          # Event (workout/sleep) queries/mutations
│       ├── dataPoints.ts      # Time-series queries/mutations
│       ├── dataSources.ts     # Data source management
│       ├── summaries.ts       # Daily summary queries/mutations
│       ├── syncJobs.ts        # Sync job tracking
│       ├── oauthStates.ts     # OAuth state management
│       ├── oauthActions.ts    # OAuth flow actions (generateAuthUrl, handleCallback)
│       ├── syncWorkflow.ts    # Sync engine (per-connection + cron)
│       ├── http.ts            # HTTP handlers (OAuth callback, webhooks)
│       ├── lifecycle.ts       # GDPR user data deletion
│       ├── convex.config.ts   # Component config
│       ├── providers/
│       │   ├── types.ts       # Provider interfaces
│       │   ├── oauth.ts       # Generic OAuth utilities (PKCE, token exchange)
│       │   ├── strava.ts      # Strava provider (OAuth config, normalization, fetch)
│       │   └── registry.ts    # Provider registry
│       └── *.test.ts          # Tests (10 files, 80 tests)
├── package.json
├── tsconfig.json
└── README.md
```

## License

Apache-2.0
