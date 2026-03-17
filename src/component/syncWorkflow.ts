/**
 * Sync workflow — fetches data from a provider and stores it.
 *
 * Uses Convex actions for external API calls and mutations for DB writes.
 * Designed to be called by @convex-dev/workflow for durability,
 * but also works as a standalone action for simpler use cases.
 */

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, action, internalAction } from "./_generated/server";
import { getProvider } from "./providers/registry";
import type { NormalizedEvent } from "./providers/types";
import { providerName } from "./schema";

// Maximum events per batch mutation (stay well within 1-second timeout)
const BATCH_SIZE = 50;
const DATA_POINT_BATCH_SIZE = 200;

type DataSourceCache = Map<string, Id<"dataSources">>;

function sourceCacheKey(
  provider: string,
  metadata: {
    deviceModel?: string;
    softwareVersion?: string;
    source?: string;
    deviceType?: string;
    originalSourceName?: string;
  },
): string {
  return [
    provider,
    metadata.deviceModel ?? "",
    metadata.softwareVersion ?? "",
    metadata.source ?? provider,
    metadata.deviceType ?? "",
    metadata.originalSourceName ?? "",
  ].join("::");
}

async function ensureDataSource(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    userId: string;
    provider: string;
    connectionId: Id<"connections">;
  },
  cache: DataSourceCache,
  metadata: {
    deviceModel?: string;
    softwareVersion?: string;
    source?: string;
    deviceType?: string;
    originalSourceName?: string;
  } = {},
): Promise<Id<"dataSources">> {
  const key = sourceCacheKey(args.provider, metadata);
  const cached = cache.get(key);
  if (cached) return cached;

  const id = await ctx.runMutation(api.dataSources.getOrCreate, {
    userId: args.userId,
    provider: args.provider,
    connectionId: args.connectionId,
    deviceModel: metadata.deviceModel,
    softwareVersion: metadata.softwareVersion,
    source: metadata.source ?? args.provider,
    deviceType: metadata.deviceType,
    originalSourceName: metadata.originalSourceName,
  });

  cache.set(key, id);
  return id;
}

function toEventDoc(event: NormalizedEvent, dataSourceId: Id<"dataSources">, userId: string) {
  return {
    dataSourceId,
    userId,
    category: event.category,
    type: event.type,
    sourceName: event.sourceName,
    durationSeconds: event.durationSeconds,
    startDatetime: event.startDatetime,
    endDatetime: event.endDatetime,
    externalId: event.externalId,
    heartRateAvg: event.heartRateAvg,
    heartRateMax: event.heartRateMax,
    heartRateMin: event.heartRateMin,
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
  };
}

/**
 * Run a full sync for a single connection.
 *
 * 1. Ensures the access token is valid (refreshes if needed).
 * 2. Fetches workouts from the provider API.
 * 3. Stores events in batches via mutations.
 * 4. Updates the connection's lastSyncedAt timestamp.
 */
export const syncConnection = internalAction({
  args: {
    connectionId: v.id("connections"),
    userId: v.string(),
    provider: providerName,
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    clientId: v.string(),
    clientSecret: v.string(),
    subscriptionKey: v.optional(v.string()),
    startDate: v.number(), // unix ms
    endDate: v.number(), // unix ms
  },
  handler: async (ctx, args) => {
    // Create a sync job to track progress
    const syncJobId = await ctx.runMutation(api.syncJobs.create, {
      userId: args.userId,
      provider: args.provider,
      status: "running",
      startedAt: Date.now(),
    });

    const credentials = {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      subscriptionKey: args.subscriptionKey,
    };

    try {
      // 1. Ensure valid token
      const accessToken = await ctx.runAction(internal.oauthActions.ensureValidToken, {
        connectionId: args.connectionId,
        provider: args.provider,
        accessToken: args.accessToken,
        refreshToken: args.refreshToken,
        tokenExpiresAt: args.tokenExpiresAt,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        subscriptionKey: args.subscriptionKey,
      });

      // 2. Fetch provider data
      const providerDef = getProvider(args.provider);
      if (!providerDef) {
        throw new Error(`Provider "${args.provider}" is not implemented`);
      }

      const sourceCache: DataSourceCache = new Map();
      let recordsProcessed = 0;

      const events = providerDef.fetchEvents
        ? await providerDef.fetchEvents(accessToken, args.startDate, args.endDate, credentials)
        : [];

      for (let i = 0; i < events.length; i += BATCH_SIZE) {
        const batch = events.slice(i, i + BATCH_SIZE);
        const eventDocs = await Promise.all(
          batch.map(async (event: NormalizedEvent) => {
            const dataSourceId = await ensureDataSource(
              ctx,
              {
                userId: args.userId,
                provider: args.provider,
                connectionId: args.connectionId,
              },
              sourceCache,
              {
                deviceModel: event.deviceModel,
                softwareVersion: event.softwareVersion,
                source: event.source ?? args.provider,
                deviceType: event.deviceType,
                originalSourceName: event.originalSourceName,
              },
            );

            return toEventDoc(event, dataSourceId, args.userId);
          }),
        );

        await ctx.runMutation(internal.events.storeEventBatch, {
          events: eventDocs,
        });
        recordsProcessed += batch.length;
      }

      const dataPoints = providerDef.fetchDataPoints
        ? await providerDef.fetchDataPoints(accessToken, args.startDate, args.endDate, credentials)
        : [];

      const pointGroups = new Map<
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
        const dataSourceId = await ensureDataSource(
          ctx,
          {
            userId: args.userId,
            provider: args.provider,
            connectionId: args.connectionId,
          },
          sourceCache,
          {
            deviceModel: point.deviceModel,
            softwareVersion: point.softwareVersion,
            source: point.source ?? args.provider,
            deviceType: point.deviceType,
            originalSourceName: point.originalSourceName,
          },
        );

        const key = `${dataSourceId}::${point.seriesType}`;
        const group = pointGroups.get(key) ?? {
          dataSourceId,
          seriesType: point.seriesType,
          points: [],
        };
        group.points.push({
          recordedAt: point.recordedAt,
          value: point.value,
          externalId: point.externalId,
        });
        pointGroups.set(key, group);
      }

      for (const group of pointGroups.values()) {
        for (let i = 0; i < group.points.length; i += DATA_POINT_BATCH_SIZE) {
          await ctx.runMutation(internal.dataPoints.storeBatch, {
            dataSourceId: group.dataSourceId,
            seriesType: group.seriesType,
            points: group.points.slice(i, i + DATA_POINT_BATCH_SIZE),
          });
          recordsProcessed += Math.min(DATA_POINT_BATCH_SIZE, group.points.length - i);
        }
      }

      const summaries = providerDef.fetchDailySummaries
        ? await providerDef.fetchDailySummaries(
            accessToken,
            args.startDate,
            args.endDate,
            credentials,
          )
        : [];

      for (const summary of summaries) {
        await ctx.runMutation(internal.summaries.upsert, {
          userId: args.userId,
          ...summary,
        });
        recordsProcessed += 1;
      }

      // 5. Mark connection as synced
      await ctx.runMutation(internal.connections.markSynced, {
        connectionId: args.connectionId,
      });

      // 6. Update sync job status
      await ctx.runMutation(internal.syncJobs.updateStatus, {
        jobId: syncJobId,
        status: "completed",
        recordsProcessed,
      });
    } catch (error) {
      // Mark sync job as failed
      await ctx.runMutation(internal.syncJobs.updateStatus, {
        jobId: syncJobId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });

      // If token error, mark connection status
      if (error instanceof Error && error.message.includes("Authorization expired")) {
        await ctx.runMutation(internal.connections.updateStatus, {
          connectionId: args.connectionId,
          status: "expired",
        });
      }

      throw error;
    }
  },
});

/**
 * Sync all active connections for all users.
 * Intended to be called by a Convex cron (e.g., every 15 minutes).
 */
export const syncAllActive = action({
  args: {
    clientCredentials: v.object({
      strava: v.optional(
        v.object({
          clientId: v.string(),
          clientSecret: v.string(),
        }),
      ),
      garmin: v.optional(
        v.object({
          clientId: v.string(),
          clientSecret: v.string(),
        }),
      ),
      polar: v.optional(
        v.object({
          clientId: v.string(),
          clientSecret: v.string(),
        }),
      ),
      whoop: v.optional(
        v.object({
          clientId: v.string(),
          clientSecret: v.string(),
        }),
      ),
      suunto: v.optional(
        v.object({
          clientId: v.string(),
          clientSecret: v.string(),
          subscriptionKey: v.optional(v.string()),
        }),
      ),
    }),
    syncWindowHours: v.optional(v.number()), // default: 24
  },
  handler: async (ctx, args) => {
    const activeConnections = await ctx.runQuery(internal.connections.getAllActive, {});
    const endDate = Date.now();

    for (const conn of activeConnections) {
      const creds = args.clientCredentials[conn.provider as keyof typeof args.clientCredentials];
      if (!creds) continue;

      const windowMs = (args.syncWindowHours ?? 24) * 60 * 60 * 1000;
      const startDate = Math.max(conn.lastSyncedAt ?? endDate - windowMs, endDate - windowMs);

      try {
        await ctx.runAction(internal.syncWorkflow.syncConnection, {
          connectionId: conn._id,
          userId: conn.userId,
          provider: conn.provider,
          accessToken: conn.accessToken,
          refreshToken: conn.refreshToken,
          tokenExpiresAt: conn.tokenExpiresAt,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          subscriptionKey: "subscriptionKey" in creds ? creds.subscriptionKey : undefined,
          startDate,
          endDate,
        });
      } catch {
        // Individual connection failures shouldn't stop the entire sync.
        // Errors are already logged in the sync job record.
        console.error(`Sync failed for connection ${conn._id}`);
      }
    }
  },
});
