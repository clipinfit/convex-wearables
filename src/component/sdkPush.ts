import { v } from "convex/values";
import { SERIES_TYPES } from "../client/types";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action } from "./_generated/server";

const sdkProviderName = v.union(v.literal("apple"), v.literal("google"), v.literal("samsung"));
const EVENT_BATCH_SIZE = 50;
const DATA_POINT_BATCH_SIZE = 200;
const MAX_EVENTS_PER_REQUEST = 500;
const MAX_DATA_POINTS_PER_REQUEST = 10000;
const MAX_SUMMARIES_PER_REQUEST = 1000;
const SERIES_TYPE_ALIASES = {
  hrv_rmssd: "heart_rate_variability_rmssd",
} as const;
const validSeriesTypes = new Set(Object.keys(SERIES_TYPES));

const deviceMetadataValidator = v.object({
  model: v.optional(v.string()),
  softwareVersion: v.optional(v.string()),
  source: v.optional(v.string()),
  deviceType: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
});

const sourceMetadataValidator = v.object({
  deviceModel: v.optional(v.string()),
  softwareVersion: v.optional(v.string()),
  source: v.optional(v.string()),
  deviceType: v.optional(v.string()),
  originalSourceName: v.optional(v.string()),
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
});

const sdkSummaryValidator = v.object({
  date: v.string(),
  category: v.string(),
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
    originalSourceName: item.originalSourceName ?? defaults?.originalSourceName,
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
          type: event.type,
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
      await ctx.runMutation(internal.summaries.upsert, {
        userId: args.userId,
        ...summary,
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
  },
});

function sourceMetadataFromDevice(
  device:
    | {
        model?: string;
        softwareVersion?: string;
        source?: string;
        deviceType?: string;
        originalSourceName?: string;
      }
    | undefined,
): SourceMetadata | undefined {
  if (!device) return undefined;
  return {
    deviceModel: device.model,
    softwareVersion: device.softwareVersion,
    source: device.source,
    deviceType: device.deviceType,
    originalSourceName: device.originalSourceName,
  };
}

function normalizeSeriesType(seriesType: string): string {
  const normalized =
    SERIES_TYPE_ALIASES[seriesType as keyof typeof SERIES_TYPE_ALIASES] ?? seriesType;
  if (!validSeriesTypes.has(normalized)) {
    throw new Error(`Unsupported series type "${seriesType}"`);
  }
  return normalized;
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
