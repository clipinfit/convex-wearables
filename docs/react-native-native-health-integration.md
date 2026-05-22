---
date: 2026-05-22
status: IMPLEMENTED
owner_repo: convex-wearables
mobile_repo: clipin-app
---

# React Native Native Health Integration

This document describes how CLIPIN implemented Apple Health and Health Connect in the React Native app and how those integrations write into `@clipin/convex-wearables`.

It is written for React Native developers maintaining the mobile ingestion layer. The Convex component is intentionally provider-neutral: the app reads native health-store data on the device, normalizes it into the SDK push payload, and the component stores it as connections, data sources, events, time-series data points, and daily summaries.

## Status

- Apple Health is implemented through HealthKit on iOS.
- Health Connect is implemented on Android.
- Direct Samsung Health SDK integration is parked. Android users should use Health Connect where Samsung Health is configured to share data into Health Connect. In that case Samsung-origin records arrive through the existing `google` provider path, with source metadata preserved when Health Connect exposes it.
- The component still supports `provider: "samsung"` in the generic SDK push path for a future direct Samsung integration, but CLIPIN's React Native implementation currently exposes only `apple` and `google` native providers.

## Repositories And Key Files

Mobile implementation in `clipin-app`:

- `apps/app/lib/nativeHealth/client.ts` coordinates permissions, sync, chunking, retries, and local sync state.
- `apps/app/lib/nativeHealth/appleHealth.ts` reads HealthKit and builds normalized payloads.
- `apps/app/lib/nativeHealth/healthConnect.ts` reads Health Connect and builds normalized payloads.
- `apps/app/lib/nativeHealth/normalization.ts` contains shared unit conversion, sleep-stage mapping, summary builders, and payload builders.
- `apps/app/lib/nativeHealth/storage.ts` stores installation state, HealthKit anchors, and sync locks in AsyncStorage.
- `apps/app/lib/nativeHealth/permissions.ts` defines the launch read scopes.
- `apps/app/app/(app)/wearables.tsx` provides the user-facing connect, sync, permission repair, and disconnect workflow.
- `packages/backend/convex/wearables/wearables.ts` exposes the authenticated backend action `ingestNativeProviderPayload`.
- `packages/backend/convex/wearables/canonical.ts` and `canonicalTimeSeries.ts` implement CLIPIN's product-level canonical read policy.

Component implementation in this repo:

- `src/component/sdkPush.ts` ingests normalized SDK/mobile health payloads.
- `src/component/dataSources.ts` creates source records per provider/device/source.
- `src/component/events.ts` stores workouts and sleep sessions with deduplication.
- `src/component/dataPoints.ts` stores time-series metrics.
- `src/component/summaries.ts` stores provider-aware daily summaries.
- `src/component/schema.ts` defines `connections`, `dataSources`, `events`, `dataPoints`, `dailySummaries`, and time-series rollup tables.
- `src/client/types.ts` defines the public SDK push payload types.

## Native Dependencies And App Configuration

The React Native app uses:

- `@kingstinct/react-native-healthkit` for Apple Health / HealthKit.
- `react-native-health-connect` for Health Connect reads.
- `expo-health-connect` and `react-native-nitro-modules` as supporting Android native dependencies.

The app config must include:

- iOS HealthKit usage strings for read access and the no-write launch posture.
- The HealthKit config plugin with background delivery disabled for launch.
- Android Health Connect read permissions for exercise, sleep, heart rate, resting heart rate, HRV, steps, active calories, and total calories.
- Android `minSdkVersion` 26.
- A Health Connect permission rationale activity wired by the local store-review plugin.

Launch intentionally does not request Health Connect history or background permissions. Health Connect therefore uses a bounded initial import plus foreground/manual sync. Apple Health uses HealthKit anchors for incremental reads.

## Permissions

Apple Health read types:

- workouts
- sleep analysis
- heart rate
- resting heart rate
- HRV SDNN
- step count
- active energy burned
- basal energy burned

Apple Health write types are empty. CLIPIN does not write data to Apple Health in this implementation.

Health Connect read permissions:

- `ExerciseSession`
- `SleepSession`
- `HeartRate`
- `RestingHeartRate`
- `HeartRateVariabilityRmssd`
- `Steps`
- `ActiveCaloriesBurned`
- `TotalCaloriesBurned`

Permission handling is platform-specific:

- iOS checks `isHealthDataAvailableAsync`, requests HealthKit authorization, and later treats `shouldRequest` as revoked.
- Android checks Health Connect SDK availability, initializes the SDK, requests all launch read permissions, and classifies partial grants as `limited-permissions`.
- If Health Connect is unavailable, the UI routes the user to install or update Health Connect through Google Play, with a web fallback.

## Local Installation State

The React Native app maintains a local installation record per app user and provider:

```ts
{
  userId: string;
  provider: "apple" | "google";
  installationId: string;
  status: "connected" | "revoked" | "disconnected";
  createdAt: number;
  updatedAt: number;
  lastSuccessfulSyncAt?: number;
  lastPermissionCheckAt?: number;
  permissionCancelCount?: number;
}
```

This lives in AsyncStorage under `native-health/...` keys. The `installationId` is sent as `providerUserId` to the backend. It is not a HealthKit or Health Connect account id; it identifies this device/app installation for native health ingestion.

Apple Health anchors are also stored locally per installation and cursor family:

- workouts
- sleep
- heart rate
- resting heart rate
- heart rate variability

Health Connect does not use anchors in this implementation. It uses `lastSuccessfulSyncAt` plus a 24-hour overlap window to safely re-read recent records.

## Sync Windows

Initial read windows are bounded to avoid oversized mobile payloads:

| Provider | Workouts | Sleep | Activity summaries | Heart rate | Resting HR | HRV / recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Apple Health | 90 days | 90 days | 90 days | 14 days | 30 days | 30 days |
| Health Connect | 30 days | 30 days | 30 days | 14 days | 30 days | 30 days |

After a successful Health Connect sync, later reads start from `lastSuccessfulSyncAt - 24h` to catch late-arriving or updated records. Convex-side deduplication makes this overlap safe.

## Data Read From Native Stores

Apple Health:

- Reads workouts with `queryWorkoutSamplesWithAnchor`.
- Reads sleep samples with `queryCategorySamplesWithAnchor`.
- Reads heart-rate, resting-heart-rate, and HRV quantity samples with `queryQuantitySamplesWithAnchor`.
- Reads daily step, active calorie, and basal calorie totals with `queryStatisticsCollectionForQuantity`.
- Converts distances to meters and energy to kilocalories.
- Groups adjacent sleep samples from the same original source into sleep sessions.
- Uses HealthKit sample/source/device metadata to populate `deviceModel`, `deviceType`, `softwareVersion`, and `originalSourceName`.

Health Connect:

- Reads paginated `ExerciseSession`, `SleepSession`, `HeartRate`, `RestingHeartRate`, and `HeartRateVariabilityRmssd` records.
- Reads daily `Steps`, `ActiveCaloriesBurned`, and `TotalCaloriesBurned` aggregates.
- Maps record metadata data origin and device information into source metadata.
- Keeps activity summary origin only when a daily aggregate has a single origin. Mixed-origin aggregate days intentionally omit `originalSourceName`.

Steps and calories are ingested as daily summaries only. They are not sent as raw time-series data points in the launch implementation.

## Normalized Mobile Payload

The mobile app sends a `NativeHealthPayload`, which is compatible with the component `SdkPushPayload`:

```ts
{
  provider: "apple" | "google";
  providerUserId: installationId;
  syncTimestamp: Date.now();
  sourceMetadata: {
    source: "healthkit" | "health-connect";
    deviceModel?: string;
    softwareVersion?: string;
    deviceType?: string;
    originalSourceName?: string;
  };
  events?: NativeHealthEvent[];
  dataPoints?: NativeHealthDataPoint[];
  summaries?: NativeHealthSummary[];
}
```

The app does not send `providerUsername` for Apple Health or Health Connect.

Payload collections are chunked before upload:

- workout events: 100 per chunk
- sleep events: 50 per chunk
- data points: 2,000 per chunk
- summaries: 90 per chunk

Transient upload failures are retried for network/timeouts, HTTP 408, HTTP 429, and 5xx errors.

## Backend Wrapper In CLIPIN

The app does not call the component directly. It calls CLIPIN's authenticated Convex action:

```ts
api.wearables.ingestNativeProviderPayload
```

That wrapper:

- Gets the authenticated Clerk/CLIPIN user.
- Checks feature flags for `appleHealth` or `healthConnect`.
- Requires wearables entitlement/CLIPIN PRO access.
- Removes `providerUsername` from the forwarded payload.
- Adds the Clerk subject as `userId`.
- Calls `components.wearables.sdkPush.ingestNormalizedPayload`.
- Upserts a CLIPIN app-level `native_health_installations` record with permission/sync metadata.

The app-level installation table is separate from the component. It powers the CLIPIN UI state for connected/revoked/disconnected native installations.

## Component Ingestion Flow

`src/component/sdkPush.ts` handles normalized payload ingestion:

1. `connections.ensurePushConnection` creates or updates the user's provider connection for `apple`, `google`, or `samsung`.
2. Source metadata is resolved from top-level `sourceMetadata` or legacy `device` metadata.
3. `dataSources.getOrCreate` creates one data source per user/provider/device/source combination.
4. Events are written to `events` in batches of 50.
5. Data points are grouped by `dataSourceId + seriesType` and written in batches of 200.
6. Summaries are upserted into `dailySummaries`.
7. The provider connection is marked synced.

Component request limits:

- max events per request: 500
- max data points per request: 10,000
- max summaries per request: 1,000

Events deduplicate by `externalId` when present, then by `dataSourceId + startDatetime + endDatetime`.

Data points deduplicate by `dataSourceId + seriesType + recordedAt`. Existing points at the same timestamp are patched.

Daily summaries are provider-aware. New summary writes are keyed by `userId + provider + category + date`, so Apple Health, Health Connect, Garmin, and future Samsung summaries do not overwrite each other for the same day.

## Stored Data Model

The native health payload lands in these component tables:

- `connections`: one active/revoked/error provider connection per user/provider.
- `dataSources`: source/device provenance for a provider. Native health often has multiple sources beneath one provider, such as Apple Watch, iPhone, Garmin mirrored through Apple Health, or Samsung Health via Health Connect.
- `events`: workouts and sleep sessions.
- `dataPoints`: high-frequency time-series values such as heart rate, resting heart rate, and HRV.
- `dailySummaries`: daily activity, sleep, and recovery summaries.
- `timeSeriesRollups`: policy-managed rollups for dense historical time-series data.

The component stores source provenance but does not make product-level display decisions. Host apps should apply their own canonical policy when multiple providers contain overlapping data.

## Canonical Provider And Device Priority

CLIPIN applies canonical selection in the host backend, not inside the reusable component.

Current CLIPIN provider rank:

| Rank | Provider |
| ---: | --- |
| 0 | Garmin |
| 10 | Whoop |
| 15 | Polar |
| 15 | Suunto |
| 20 | Strava |
| 30 | Apple Health |
| 35 | Health Connect |
| 40 | Samsung direct, reserved for future use |

Lower rank wins.

Daily summaries:

- CLIPIN reads provider-aware summaries.
- For a given `category + date`, `chooseCanonicalSummaries` picks the summary from the highest-priority provider.

Time series:

- CLIPIN sorts candidate data sources by provider rank.
- It queries each source for the requested series.
- The first source with points is selected as canonical for that read window.
- This avoids mixing heart-rate streams from multiple devices in a single chart or summary.

Device/source priority:

- Native health stores can contain several underlying devices and apps beneath one provider.
- The component stores those as separate `dataSources` when metadata differs by provider, device model, and source.
- CLIPIN does not currently define a separate device-rank table such as "Apple Watch before iPhone" or "Samsung phone before Samsung watch".
- In practice, direct provider integrations win over mirrored native-store copies because provider rank is applied first. For example, direct Garmin beats a Garmin workout mirrored through Apple Health.
- Within the same provider rank, source metadata is preserved for attribution and duplicate detection, but product code should not assume a stable per-device winner unless it adds an explicit source/device ranking policy.

Events:

- CLIPIN sorts events by provider rank.
- It scores potential duplicates using source/origin metadata, time overlap, workout type, duration, distance, calories, steps, and heart-rate similarity.
- If an event is a strong duplicate of a higher-priority selected event, it is suppressed from canonical views.

Source metadata matters here. For example, a Garmin workout mirrored into Apple Health may have `provider: "apple"` but `originalSourceName` or device metadata containing Garmin. CLIPIN uses that origin hint to recognize the Apple record as a mirror of a direct Garmin record.

## Samsung Health Decision

Do not build direct Samsung Health SDK ingestion unless product requirements change.

The preferred Android path is:

1. User connects Samsung Health to Health Connect on the device, where supported.
2. CLIPIN requests Health Connect permissions.
3. Health Connect exposes approved records and aggregate data to CLIPIN.
4. CLIPIN ingests those records as `provider: "google"` with `source: "health-connect"`.
5. If Health Connect exposes Samsung as the origin, CLIPIN stores it in `originalSourceName`.

This keeps one Android native-health implementation and avoids adding a second Samsung-specific native SDK, permission flow, test matrix, and store-review path.

If direct Samsung is revived later, the mobile app should normalize Samsung SDK records into the same SDK push payload and use `provider: "samsung"`. The component already accepts that provider in `sdkPush.ingestNormalizedPayload`.

## Caveats

- HealthKit authorization is not per-type visible in the same way as Android grants. A completed Apple authorization request does not prove every requested data type has usable data.
- Health Connect partial grants are treated as limited permissions. The UI should prompt the user to grant all launch permissions before syncing.
- Health Connect launch scope does not include background or long-history permissions.
- Apple Health background delivery is disabled for launch.
- Daily step and calorie values are aggregate-only. Do not add raw step/calorie time-series ingestion without revisiting volume, retention, and canonical summary behavior.
- Health Connect daily aggregates may be mixed-origin. When origins are mixed, `originalSourceName` is intentionally omitted for that daily summary.
- `providerUserId` for native providers is a generated installation id, not a stable external user id from Apple or Google.
- The component stores multiple providers and sources. Product surfaces must use canonical reads to avoid displaying duplicated workouts, sleep sessions, or mixed heart-rate streams.

## Verification

The React Native app has a native-health verification script and targeted tests:

- `bun run verify:native-health`
- `bun run verify:native-health:release`
- `lib/nativeHealth/*.test.ts`
- backend tests for `convex/wearables/canonical.test.ts`, `summary.test.ts`, `wearables.test.ts`, and `wearables.integration.test.ts`

The verification script checks dependency versions, app config, HealthKit/Health Connect permission posture, backend dependency on `@clipin/convex-wearables`, payload safety rules, and stale implementation notes.

For release confidence, test on physical devices:

- iPhone with Apple Health data and HealthKit capability/provisioning enabled.
- Android device with Health Connect installed and populated.
- Garmin plus Apple Health coexistence.
- Garmin plus Health Connect coexistence.
- Android device where Samsung Health shares data into Health Connect, if Samsung-origin behavior is being validated.
