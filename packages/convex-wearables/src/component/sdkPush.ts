import { v } from "convex/values";
import type { SdkPushPayload } from "../client/types";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";
import { normalizeSdkSeriesType, parseSdkPayloadV2 } from "./sdkPushValidation";

const sdkProviderName = v.union(v.literal("apple"), v.literal("google"), v.literal("samsung"));
const sdkIngestionCategoryCountsValidator = v.object({
  received: v.number(),
  accepted: v.number(),
  rejected: v.number(),
  stored: v.number(),
});
const sdkIngestionRejectionValidator = v.object({
  category: v.union(
    v.literal("payload"),
    v.literal("events"),
    v.literal("dataPoints"),
    v.literal("summaries"),
    v.literal("dailySummaries"),
  ),
  index: v.number(),
  code: v.union(
    v.literal("invalid_envelope"),
    v.literal("invalid_type"),
    v.literal("invalid_value"),
    v.literal("limit_exceeded"),
    v.literal("missing_field"),
    v.literal("unknown_field"),
    v.literal("unsupported_series_type"),
  ),
  path: v.optional(v.string()),
  message: v.string(),
});
const EVENT_BATCH_SIZE = 50;
const DATA_POINT_BATCH_SIZE = 200;
const MAX_EVENTS_PER_REQUEST = 500;
const MAX_DATA_POINTS_PER_REQUEST = 10000;
const MAX_SUMMARIES_PER_REQUEST = 1000;

const deviceMetadataValidator = v.object({
  model: v.optional(v.string()),
  softwareVersion: v.optional(v.string()),
  source: v.optional(v.string()),
  deviceType: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
  appId: v.optional(v.string()),
  app_id: v.optional(v.string()),
  bundleIdentifier: v.optional(v.string()),
  bundle_identifier: v.optional(v.string()),
});

const sourceMetadataValidator = v.object({
  deviceModel: v.optional(v.string()),
  softwareVersion: v.optional(v.string()),
  source: v.optional(v.string()),
  deviceType: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
  appId: v.optional(v.string()),
  app_id: v.optional(v.string()),
  bundleIdentifier: v.optional(v.string()),
  bundle_identifier: v.optional(v.string()),
});

const sdkEventValidator = v.object({
  category: v.union(v.literal("workout"), v.literal("sleep")),
  type: v.optional(v.string()),
  sourceName: v.optional(v.string()),
  durationSeconds: v.optional(v.number()),
  startDatetime: v.number(),
  endDatetime: v.optional(v.number()),
  externalId: v.optional(v.string()),
  heartRateMin: v.optional(v.number()),
  heartRateMax: v.optional(v.number()),
  heartRateAvg: v.optional(v.number()),
  energyBurned: v.optional(v.number()),
  distance: v.optional(v.number()),
  stepsCount: v.optional(v.number()),
  maxSpeed: v.optional(v.number()),
  maxWatts: v.optional(v.number()),
  movingTimeSeconds: v.optional(v.number()),
  totalElevationGain: v.optional(v.number()),
  averageSpeed: v.optional(v.number()),
  averageWatts: v.optional(v.number()),
  elevHigh: v.optional(v.number()),
  elevLow: v.optional(v.number()),
  sleepTotalDurationMinutes: v.optional(v.number()),
  sleepTimeInBedMinutes: v.optional(v.number()),
  sleepEfficiencyScore: v.optional(v.number()),
  sleepDeepMinutes: v.optional(v.number()),
  sleepRemMinutes: v.optional(v.number()),
  sleepLightMinutes: v.optional(v.number()),
  sleepAwakeMinutes: v.optional(v.number()),
  isNap: v.optional(v.boolean()),
  sleepStages: v.optional(
    v.array(
      v.object({
        stage: v.string(),
        startTime: v.number(),
        endTime: v.number(),
      }),
    ),
  ),
  deviceModel: v.optional(v.string()),
  softwareVersion: v.optional(v.string()),
  source: v.optional(v.string()),
  deviceType: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
  appId: v.optional(v.string()),
  app_id: v.optional(v.string()),
  bundleIdentifier: v.optional(v.string()),
  bundle_identifier: v.optional(v.string()),
});

const sdkDataPointValidator = v.object({
  seriesType: v.string(),
  recordedAt: v.number(),
  value: v.number(),
  externalId: v.optional(v.string()),
  deviceModel: v.optional(v.string()),
  softwareVersion: v.optional(v.string()),
  source: v.optional(v.string()),
  deviceType: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
  appId: v.optional(v.string()),
  app_id: v.optional(v.string()),
  bundleIdentifier: v.optional(v.string()),
  bundle_identifier: v.optional(v.string()),
});

const sdkSummaryValidator = v.object({
  date: v.string(),
  category: v.string(),
  source: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
  appId: v.optional(v.string()),
  app_id: v.optional(v.string()),
  bundleIdentifier: v.optional(v.string()),
  bundle_identifier: v.optional(v.string()),
  totalSteps: v.optional(v.number()),
  totalCalories: v.optional(v.number()),
  activeCalories: v.optional(v.number()),
  activeMinutes: v.optional(v.number()),
  totalDistance: v.optional(v.number()),
  floorsClimbed: v.optional(v.number()),
  avgHeartRate: v.optional(v.number()),
  maxHeartRate: v.optional(v.number()),
  minHeartRate: v.optional(v.number()),
  sleepDurationMinutes: v.optional(v.number()),
  sleepEfficiency: v.optional(v.number()),
  deepSleepMinutes: v.optional(v.number()),
  remSleepMinutes: v.optional(v.number()),
  lightSleepMinutes: v.optional(v.number()),
  awakeDuringMinutes: v.optional(v.number()),
  timeInBedMinutes: v.optional(v.number()),
  hrvAvg: v.optional(v.number()),
  hrvRmssd: v.optional(v.number()),
  restingHeartRate: v.optional(v.number()),
  recoveryScore: v.optional(v.number()),
  weight: v.optional(v.number()),
  bodyFatPercentage: v.optional(v.number()),
  bodyMassIndex: v.optional(v.number()),
  leanBodyMass: v.optional(v.number()),
  bodyTemperature: v.optional(v.number()),
  avgStressLevel: v.optional(v.number()),
  bodyBattery: v.optional(v.number()),
  spo2Avg: v.optional(v.number()),
});

type SdkProvider = "apple" | "google" | "samsung";

type SourceMetadata = {
  deviceModel?: string;
  softwareVersion?: string;
  source?: string;
  deviceType?: string;
  originalSourceName?: string;
  appId?: string;
  app_id?: string;
  bundleIdentifier?: string;
  bundle_identifier?: string;
};

type DataSourceCache = Map<string, Id<"dataSources">>;
type ActionMutationRunner = Pick<ActionCtx, "runMutation">;

function sourceCacheKey(provider: SdkProvider, metadata: SourceMetadata): string {
  return [
    provider,
    metadata.deviceModel ?? "",
    metadata.softwareVersion ?? "",
    metadata.source ?? provider,
    metadata.deviceType ?? "",
    metadata.originalSourceName ?? "",
  ].join("::");
}

function resolveSourceMetadata(
  defaults: SourceMetadata | undefined,
  item: SourceMetadata,
): SourceMetadata {
  return {
    deviceModel: item.deviceModel ?? defaults?.deviceModel,
    softwareVersion: item.softwareVersion ?? defaults?.softwareVersion,
    source: item.source ?? defaults?.source,
    deviceType: item.deviceType ?? defaults?.deviceType,
    originalSourceName:
      item.originalSourceName ??
      item.appId ??
      item.app_id ??
      item.bundleIdentifier ??
      item.bundle_identifier ??
      defaults?.originalSourceName,
    appId: item.appId ?? defaults?.appId,
    app_id: item.app_id ?? defaults?.app_id,
    bundleIdentifier: item.bundleIdentifier ?? defaults?.bundleIdentifier,
    bundle_identifier: item.bundle_identifier ?? defaults?.bundle_identifier,
  };
}

function defaultSourceName(provider: SdkProvider): string {
  if (provider === "apple") return "Apple Health";
  if (provider === "google") return "Google Health Connect";
  return "Samsung Health";
}

async function ensureDataSource(
  ctx: ActionMutationRunner,
  args: {
    userId: string;
    provider: SdkProvider;
    connectionId: Id<"connections">;
  },
  cache: DataSourceCache,
  metadata: SourceMetadata,
): Promise<Id<"dataSources">> {
  const key = sourceCacheKey(args.provider, metadata);
  const cached = cache.get(key);
  if (cached) return cached;

  const dataSourceId = await ctx.runMutation(api.dataSources.getOrCreate, {
    userId: args.userId,
    provider: args.provider,
    connectionId: args.connectionId,
    deviceModel: metadata.deviceModel,
    softwareVersion: metadata.softwareVersion,
    source: metadata.source ?? args.provider,
    deviceType: metadata.deviceType,
    originalSourceName: metadata.originalSourceName,
  });

  cache.set(key, dataSourceId);
  return dataSourceId;
}

export const ingestNormalizedPayload = action({
  args: {
    userId: v.string(),
    provider: sdkProviderName,
    providerUserId: v.optional(v.string()),
    providerUsername: v.optional(v.string()),
    syncTimestamp: v.optional(v.number()),
    device: v.optional(deviceMetadataValidator),
    sourceMetadata: v.optional(sourceMetadataValidator),
    events: v.optional(v.array(sdkEventValidator)),
    dataPoints: v.optional(v.array(sdkDataPointValidator)),
    summaries: v.optional(v.array(sdkSummaryValidator)),
    dailySummaries: v.optional(v.array(sdkSummaryValidator)),
  },
  returns: v.object({
    connectionId: v.id("connections"),
    eventsStored: v.number(),
    dataPointsStored: v.number(),
    summariesStored: v.number(),
  }),
  handler: async (ctx, args) => {
    return await ingestValidatedPayload(ctx, args);
  },
});

export const ingestNormalizedPayloadV2 = action({
  args: {
    userId: v.string(),
    provider: sdkProviderName,
    requestId: v.string(),
    mode: v.optional(v.union(v.literal("partial"), v.literal("strict"))),
    payload: v.any(),
  },
  returns: v.object({
    requestId: v.string(),
    status: v.union(v.literal("accepted"), v.literal("partially_accepted"), v.literal("rejected")),
    mode: v.union(v.literal("partial"), v.literal("strict")),
    connectionId: v.optional(v.id("connections")),
    counts: v.object({
      received: v.number(),
      accepted: v.number(),
      rejected: v.number(),
      stored: v.number(),
    }),
    categories: v.object({
      events: sdkIngestionCategoryCountsValidator,
      dataPoints: sdkIngestionCategoryCountsValidator,
      summaries: sdkIngestionCategoryCountsValidator,
    }),
    rejections: v.array(sdkIngestionRejectionValidator),
    rejectionCountTruncated: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.requestId.trim().length === 0) {
      throw new Error("SDK v2 requestId must not be empty");
    }

    const parsed = parseSdkPayloadV2(args.payload, args.mode ?? "partial");
    const emptyResult = {
      requestId: args.requestId,
      status: parsed.status,
      mode: parsed.mode,
      counts: { ...parsed.counts, stored: 0 },
      categories: {
        events: { ...parsed.categories.events, stored: 0 },
        dataPoints: { ...parsed.categories.dataPoints, stored: 0 },
        summaries: { ...parsed.categories.summaries, stored: 0 },
      },
      rejections: parsed.rejections,
      rejectionCountTruncated: parsed.rejectionCountTruncated,
    };

    if (!parsed.canPersist || parsed.counts.accepted === 0) {
      return emptyResult;
    }

    const stored = await ingestValidatedPayload(ctx, {
      userId: args.userId,
      provider: args.provider,
      ...parsed.payload,
    });
    const storedTotal = stored.eventsStored + stored.dataPointsStored + stored.summariesStored;

    return {
      ...emptyResult,
      connectionId: stored.connectionId,
      counts: { ...emptyResult.counts, stored: storedTotal },
      categories: {
        events: { ...emptyResult.categories.events, stored: stored.eventsStored },
        dataPoints: {
          ...emptyResult.categories.dataPoints,
          stored: stored.dataPointsStored,
        },
        summaries: {
          ...emptyResult.categories.summaries,
          stored: stored.summariesStored,
        },
      },
    };
  },
});

async function ingestValidatedPayload(ctx: ActionCtx, args: SdkPushPayload) {
  const connectionId = await ctx.runMutation(internal.connections.ensurePushConnection, {
    userId: args.userId,
    provider: args.provider,
    providerUserId: args.providerUserId,
    providerUsername: args.providerUsername,
  });

  const sourceCache: DataSourceCache = new Map();
  const defaultMetadata = resolveSourceMetadata(
    sourceMetadataFromDevice(args.device),
    args.sourceMetadata ?? {},
  );
  const events = args.events ?? [];
  const dataPoints = args.dataPoints ?? [];
  const summaries = [...(args.summaries ?? []), ...(args.dailySummaries ?? [])];

  assertPayloadWithinLimits({ events, dataPoints, summaries });

  if (events.length > 0) {
    const docs = [];
    for (const event of events) {
      const metadata = resolveSourceMetadata(defaultMetadata, {
        deviceModel: event.deviceModel,
        softwareVersion: event.softwareVersion,
        source: event.source,
        deviceType: event.deviceType,
        originalSourceName: event.originalSourceName,
        appId: event.appId,
        app_id: event.app_id,
        bundleIdentifier: event.bundleIdentifier,
        bundle_identifier: event.bundle_identifier,
      });
      const dataSourceId = await ensureDataSource(
        ctx,
        {
          userId: args.userId,
          provider: args.provider,
          connectionId,
        },
        sourceCache,
        metadata,
      );

      docs.push({
        dataSourceId,
        userId: args.userId,
        category: event.category,
        type: event.category === "workout" ? normalizeWorkoutType(event.type) : event.type,
        sourceName: event.sourceName ?? defaultSourceName(args.provider),
        durationSeconds: event.durationSeconds,
        startDatetime: event.startDatetime,
        endDatetime: event.endDatetime,
        externalId: event.externalId,
        heartRateMin: event.heartRateMin,
        heartRateMax: event.heartRateMax,
        heartRateAvg: event.heartRateAvg,
        energyBurned: event.energyBurned,
        distance: event.distance,
        stepsCount: event.stepsCount,
        maxSpeed: event.maxSpeed,
        maxWatts: event.maxWatts,
        movingTimeSeconds: event.movingTimeSeconds,
        totalElevationGain: event.totalElevationGain,
        averageSpeed: event.averageSpeed,
        averageWatts: event.averageWatts,
        elevHigh: event.elevHigh,
        elevLow: event.elevLow,
        sleepTotalDurationMinutes: event.sleepTotalDurationMinutes,
        sleepTimeInBedMinutes: event.sleepTimeInBedMinutes,
        sleepEfficiencyScore: event.sleepEfficiencyScore,
        sleepDeepMinutes: event.sleepDeepMinutes,
        sleepRemMinutes: event.sleepRemMinutes,
        sleepLightMinutes: event.sleepLightMinutes,
        sleepAwakeMinutes: event.sleepAwakeMinutes,
        isNap: event.isNap,
        sleepStages: event.sleepStages,
      });
    }

    for (const batch of chunk(docs, EVENT_BATCH_SIZE)) {
      await ctx.runMutation(internal.events.storeEventBatch, {
        events: batch,
      });
    }
  }

  if (dataPoints.length > 0) {
    const grouped = new Map<
      string,
      {
        dataSourceId: Id<"dataSources">;
        seriesType: string;
        points: Array<{
          recordedAt: number;
          value: number;
          externalId?: string;
        }>;
      }
    >();

    for (const point of dataPoints) {
      const seriesType = normalizeSeriesType(point.seriesType);
      const metadata = resolveSourceMetadata(defaultMetadata, {
        deviceModel: point.deviceModel,
        softwareVersion: point.softwareVersion,
        source: point.source,
        deviceType: point.deviceType,
        originalSourceName: point.originalSourceName,
        appId: point.appId,
        app_id: point.app_id,
        bundleIdentifier: point.bundleIdentifier,
        bundle_identifier: point.bundle_identifier,
      });
      const dataSourceId = await ensureDataSource(
        ctx,
        {
          userId: args.userId,
          provider: args.provider,
          connectionId,
        },
        sourceCache,
        metadata,
      );

      const key = `${dataSourceId}::${seriesType}`;
      const group = grouped.get(key) ?? {
        dataSourceId,
        seriesType,
        points: [],
      };
      group.points.push({
        recordedAt: point.recordedAt,
        value: point.value,
        externalId: point.externalId,
      });
      grouped.set(key, group);
    }

    for (const group of grouped.values()) {
      for (const batch of chunk(group.points, DATA_POINT_BATCH_SIZE)) {
        await ctx.runMutation(internal.dataPoints.storeBatch, {
          dataSourceId: group.dataSourceId,
          seriesType: group.seriesType,
          points: batch,
        });
      }
    }
  }

  for (const summary of summaries) {
    const {
      appId,
      app_id,
      bundleIdentifier,
      bundle_identifier,
      originalSourceName,
      source,
      ...summaryMetrics
    } = summary;
    await ctx.runMutation(internal.summaries.upsert, {
      userId: args.userId,
      provider: args.provider,
      ...summaryMetrics,
      source: source ?? defaultMetadata.source,
      originalSourceName:
        originalSourceName ??
        appId ??
        app_id ??
        bundleIdentifier ??
        bundle_identifier ??
        defaultMetadata.originalSourceName,
    });
  }

  await ctx.runMutation(internal.connections.markSynced, {
    connectionId,
  });

  return {
    connectionId,
    eventsStored: events.length,
    dataPointsStored: dataPoints.length,
    summariesStored: summaries.length,
  };
}

function sourceMetadataFromDevice(
  device:
    | {
        model?: string;
        softwareVersion?: string;
        source?: string;
        deviceType?: string;
        originalSourceName?: string;
        appId?: string;
        app_id?: string;
        bundleIdentifier?: string;
        bundle_identifier?: string;
      }
    | undefined,
): SourceMetadata | undefined {
  if (!device) return undefined;
  return {
    deviceModel: device.model,
    softwareVersion: device.softwareVersion,
    source: device.source,
    deviceType: device.deviceType,
    originalSourceName:
      device.originalSourceName ??
      device.appId ??
      device.app_id ??
      device.bundleIdentifier ??
      device.bundle_identifier,
    appId: device.appId,
    app_id: device.app_id,
    bundleIdentifier: device.bundleIdentifier,
    bundle_identifier: device.bundle_identifier,
  };
}

function normalizeSeriesType(seriesType: string): string {
  const normalized = normalizeSdkSeriesType(seriesType);
  if (normalized === null) {
    throw new Error(`Unsupported series type "${seriesType}"`);
  }
  return normalized;
}

const SDK_WORKOUT_TYPE_ALIASES: Record<string, string> = {
  cycling_stationary: "indoor_cycling",
  boot_camp: "cardio_training",
  calisthenics: "strength_training",
  dancing: "dance",
  exercise_class: "cardio_training",
  football_american: "american_football",
  football_australian: "football",
  frisbee_disc: "disc_sports",
  guided_breathing: "meditation",
  ice_hockey: "hockey",
  ice_skating: "ice_skating",
  paddling: "paddling",
  paragliding: "paragliding",
  rock_climbing: "rock_climbing",
  roller_hockey: "hockey",
  rowing_machine: "rowing_machine",
  running_treadmill: "treadmill",
  scuba_diving: "diving",
  skiing: "alpine_skiing",
  snowshoeing: "snowshoeing",
  stair_climbing_machine: "stair_climbing",
  stretching: "stretching",
  swimming_open_water: "open_water_swimming",
  swimming_pool: "pool_swimming",
  weightlifting: "strength_training",
  wheelchair: "wheelchair",
};

function normalizeWorkoutType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  const normalized = type.trim().toLowerCase();
  if (!normalized) return undefined;
  return SDK_WORKOUT_TYPE_ALIASES[normalized] ?? normalized;
}

function assertPayloadWithinLimits(args: {
  events: unknown[];
  dataPoints: unknown[];
  summaries: unknown[];
}) {
  if (args.events.length > MAX_EVENTS_PER_REQUEST) {
    throw new Error(
      `SDK sync payload exceeds event limit (${args.events.length} > ${MAX_EVENTS_PER_REQUEST})`,
    );
  }

  if (args.dataPoints.length > MAX_DATA_POINTS_PER_REQUEST) {
    throw new Error(
      `SDK sync payload exceeds data point limit (${args.dataPoints.length} > ${MAX_DATA_POINTS_PER_REQUEST})`,
    );
  }

  if (args.summaries.length > MAX_SUMMARIES_PER_REQUEST) {
    throw new Error(
      `SDK sync payload exceeds summary limit (${args.summaries.length} > ${MAX_SUMMARIES_PER_REQUEST})`,
    );
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
