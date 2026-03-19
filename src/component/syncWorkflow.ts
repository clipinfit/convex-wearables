/**
 * Durable sync orchestration for provider pull syncs.
 *
 * The old implementation executed a whole sync inline in one action. This
 * module now enqueues a durable workflow per connection and keeps syncJobs as
 * the user-visible progress surface.
 */

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation } from "./_generated/server";
import { getProvider } from "./providers/registry";
import type {
  NormalizedDailySummary,
  NormalizedDataPoint,
  NormalizedEvent,
} from "./providers/types";
import { providerName } from "./schema";
import { durableWorkflow } from "./workflowManager";

const EVENT_BATCH_SIZE = 50;
const DATA_POINT_BATCH_SIZE = 200;
const SUMMARY_BATCH_SIZE = 50;
const DEFAULT_SYNC_WINDOW_HOURS = 24;

const syncPhase = v.union(v.literal("events"), v.literal("dataPoints"), v.literal("summaries"));

type SyncPhase = "events" | "dataPoints" | "summaries";
type DataSourceCache = Map<string, Id<"dataSources">>;
type DataSourceMutationRunner = {
  runMutation: (
    mutation: typeof api.dataSources.getOrCreate,
    args: {
      userId: string;
      provider: string;
      connectionId: Id<"connections">;
      deviceModel?: string;
      softwareVersion?: string;
      source: string;
      deviceType?: string;
      originalSourceName?: string;
    },
  ) => Promise<Id<"dataSources">>;
};

function buildSyncIdempotencyKey(args: {
  connectionId: Id<"connections">;
  mode: "manual" | "cron" | "webhook";
  windowStart: number;
  windowEnd: number;
}): string {
  return [args.connectionId, args.mode, args.windowStart, args.windowEnd].join("::");
}

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
  ctx: DataSourceMutationRunner,
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

function sortEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((a, b) => {
    if (a.startDatetime !== b.startDatetime) {
      return a.startDatetime - b.startDatetime;
    }
    return (a.externalId ?? "").localeCompare(b.externalId ?? "");
  });
}

function sortDataPoints(points: NormalizedDataPoint[]): NormalizedDataPoint[] {
  return [...points].sort((a, b) => {
    if (a.recordedAt !== b.recordedAt) {
      return a.recordedAt - b.recordedAt;
    }
    if (a.seriesType !== b.seriesType) {
      return a.seriesType.localeCompare(b.seriesType);
    }
    return (a.externalId ?? "").localeCompare(b.externalId ?? "");
  });
}

function sortSummaries(summaries: NormalizedDailySummary[]): NormalizedDailySummary[] {
  return [...summaries].sort((a, b) => {
    if (a.date !== b.date) {
      return a.date.localeCompare(b.date);
    }
    return a.category.localeCompare(b.category);
  });
}

export const requestConnectionSync = internalMutation({
  args: {
    connectionId: v.id("connections"),
    mode: v.optional(v.union(v.literal("manual"), v.literal("cron"), v.literal("webhook"))),
    triggerSource: v.optional(v.string()),
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  returns: v.object({
    syncJobId: v.id("syncJobs"),
    workflowId: v.string(),
    deduped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      throw new Error(`Connection ${args.connectionId} not found`);
    }
    if (connection.status !== "active") {
      throw new Error(`Connection ${args.connectionId} is not active`);
    }

    const mode = args.mode ?? "manual";
    const idempotencyKey = buildSyncIdempotencyKey({
      connectionId: args.connectionId,
      mode,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    });

    const existing = await ctx.db
      .query("syncJobs")
      .withIndex("by_idempotency_key", (idx) => idx.eq("idempotencyKey", idempotencyKey))
      .order("desc")
      .first();

    if (existing && (existing.status === "queued" || existing.status === "running")) {
      return {
        syncJobId: existing._id,
        workflowId: existing.workflowId ?? "",
        deduped: true,
      };
    }

    const syncJobId = await ctx.db.insert("syncJobs", {
      connectionId: connection._id,
      userId: connection.userId,
      provider: connection.provider,
      mode,
      triggerSource: args.triggerSource,
      idempotencyKey,
      status: "queued",
      startedAt: Date.now(),
      attempt: 0,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
    });

    const workflowId = await durableWorkflow.start(
      ctx,
      internal.syncWorkflow.runConnectionSync,
      { syncJobId },
      {
        startAsync: true,
        onComplete: internal.syncWorkflow.handleConnectionSyncComplete,
        context: { syncJobId },
      },
    );

    await ctx.db.patch(syncJobId, { workflowId });

    return {
      syncJobId,
      workflowId,
      deduped: false,
    };
  },
});

export const fetchSyncPhaseBatch = internalAction({
  args: {
    syncJobId: v.id("syncJobs"),
    phase: syncPhase,
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    events: v.array(v.any()),
    dataPoints: v.array(v.any()),
    summaries: v.array(v.any()),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.syncJobs.getById, {
      jobId: args.syncJobId,
    });
    if (!job) {
      throw new Error(`Sync job ${args.syncJobId} not found`);
    }

    const connection = await ctx.runQuery(internal.connections.getById, {
      connectionId: job.connectionId,
    });
    if (!connection) {
      throw new Error(`Connection ${job.connectionId} not found`);
    }

    const credentials = await ctx.runQuery(internal.providerSettings.getCredentials, {
      provider: job.provider,
    });
    if (!credentials) {
      throw new Error(`Missing stored credentials for provider "${job.provider}"`);
    }

    const providerDef = getProvider(job.provider);
    if (!providerDef) {
      throw new Error(`Provider "${job.provider}" is not implemented`);
    }

    try {
      const accessToken = await ctx.runAction(internal.oauthActions.ensureValidToken, {
        connectionId: connection._id,
        provider: connection.provider,
        accessToken: connection.accessToken ?? "",
        refreshToken: connection.refreshToken,
        tokenExpiresAt: connection.tokenExpiresAt,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        subscriptionKey: credentials.subscriptionKey,
      });

      const offset = Number(args.cursor ?? "0");
      const startDate = job.windowStart ?? Date.now() - DEFAULT_SYNC_WINDOW_HOURS * 60 * 60 * 1000;
      const endDate = job.windowEnd ?? Date.now();

      if (args.phase === "events") {
        const all = sortEvents(
          providerDef.fetchEvents
            ? await providerDef.fetchEvents(accessToken, startDate, endDate, credentials)
            : [],
        );
        const batch = all.slice(offset, offset + EVENT_BATCH_SIZE);
        return {
          events: batch,
          dataPoints: [],
          summaries: [],
          nextCursor: offset + batch.length < all.length ? String(offset + batch.length) : null,
        };
      }

      if (args.phase === "dataPoints") {
        const all = sortDataPoints(
          providerDef.fetchDataPoints
            ? await providerDef.fetchDataPoints(accessToken, startDate, endDate, credentials)
            : [],
        );
        const batch = all.slice(offset, offset + DATA_POINT_BATCH_SIZE);
        return {
          events: [],
          dataPoints: batch,
          summaries: [],
          nextCursor: offset + batch.length < all.length ? String(offset + batch.length) : null,
        };
      }

      const all = sortSummaries(
        providerDef.fetchDailySummaries
          ? await providerDef.fetchDailySummaries(accessToken, startDate, endDate, credentials)
          : [],
      );
      const batch = all.slice(offset, offset + SUMMARY_BATCH_SIZE);
      return {
        events: [],
        dataPoints: [],
        summaries: batch,
        nextCursor: offset + batch.length < all.length ? String(offset + batch.length) : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("Authorization expired") ||
        message.includes("Token expired") ||
        message.includes("Token refresh failed")
      ) {
        await ctx.runMutation(internal.connections.updateStatus, {
          connectionId: connection._id,
          status: "expired",
        });
      }
      throw error;
    }
  },
});

export const runConnectionSync = durableWorkflow.define({
  args: {
    syncJobId: v.id("syncJobs"),
  },
  returns: v.object({
    recordsProcessed: v.number(),
  }),
  handler: async (step, args): Promise<{ recordsProcessed: number }> => {
    const job = await step.runQuery(internal.syncJobs.getById, {
      jobId: args.syncJobId,
    });
    if (!job) {
      throw new Error(`Sync job ${args.syncJobId} not found`);
    }

    const connection = await step.runQuery(internal.connections.getById, {
      connectionId: job.connectionId,
    });
    if (!connection) {
      throw new Error(`Connection ${job.connectionId} not found`);
    }

    let processed = 0;
    const sourceCache: DataSourceCache = new Map();

    await step.runMutation(internal.syncJobs.updateStatus, {
      jobId: args.syncJobId,
      status: "running",
      workflowId: job.workflowId,
      lastHeartbeatAt: Date.now(),
    });

    for (const phase of ["events", "dataPoints", "summaries"] as SyncPhase[]) {
      let cursor: string | undefined;

      while (true) {
        const batch = await step.runAction(internal.syncWorkflow.fetchSyncPhaseBatch, {
          syncJobId: args.syncJobId,
          phase,
          cursor,
        });

        if (phase === "events" && batch.events.length > 0) {
          const eventDocs = await Promise.all(
            batch.events.map(async (event: NormalizedEvent) => {
              const dataSourceId = await ensureDataSource(
                step,
                {
                  userId: job.userId,
                  provider: job.provider,
                  connectionId: connection._id,
                },
                sourceCache,
                {
                  deviceModel: event.deviceModel,
                  softwareVersion: event.softwareVersion,
                  source: event.source ?? job.provider,
                  deviceType: event.deviceType,
                  originalSourceName: event.originalSourceName,
                },
              );

              return toEventDoc(event, dataSourceId, job.userId);
            }),
          );

          await step.runMutation(internal.events.storeEventBatch, {
            events: eventDocs,
          });
          processed += batch.events.length;
        }

        if (phase === "dataPoints" && batch.dataPoints.length > 0) {
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

          for (const point of batch.dataPoints as NormalizedDataPoint[]) {
            const dataSourceId = await ensureDataSource(
              step,
              {
                userId: job.userId,
                provider: job.provider,
                connectionId: connection._id,
              },
              sourceCache,
              {
                deviceModel: point.deviceModel,
                softwareVersion: point.softwareVersion,
                source: point.source ?? job.provider,
                deviceType: point.deviceType,
                originalSourceName: point.originalSourceName,
              },
            );

            const key = `${dataSourceId}::${point.seriesType}`;
            const group = grouped.get(key) ?? {
              dataSourceId,
              seriesType: point.seriesType,
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
            await step.runMutation(internal.dataPoints.storeBatch, {
              dataSourceId: group.dataSourceId,
              seriesType: group.seriesType,
              points: group.points,
            });
          }

          processed += batch.dataPoints.length;
        }

        if (phase === "summaries" && batch.summaries.length > 0) {
          for (const summary of batch.summaries as NormalizedDailySummary[]) {
            await step.runMutation(internal.summaries.upsert, {
              userId: job.userId,
              ...summary,
            });
          }
          processed += batch.summaries.length;
        }

        cursor = batch.nextCursor ?? undefined;
        await step.runMutation(internal.syncJobs.updateStatus, {
          jobId: args.syncJobId,
          status: "running",
          currentPhase: phase,
          cursor,
          recordsProcessed: processed,
          lastHeartbeatAt: Date.now(),
        });

        if (!cursor) {
          break;
        }
      }
    }

    await step.runMutation(internal.connections.markSynced, {
      connectionId: connection._id,
    });

    return { recordsProcessed: processed };
  },
});

export const handleConnectionSyncComplete = internalMutation({
  args: {
    workflowId: v.string(),
    result: v.any(),
    context: v.object({
      syncJobId: v.id("syncJobs"),
    }),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.context.syncJobId);
    if (!job) return;

    if (args.result.kind === "success") {
      const returnValue = (args.result.returnValue ?? {}) as { recordsProcessed?: number };
      await ctx.db.patch(job._id, {
        status: "completed",
        completedAt: Date.now(),
        recordsProcessed: returnValue.recordsProcessed ?? job.recordsProcessed ?? 0,
        workflowId: args.workflowId,
        lastHeartbeatAt: Date.now(),
      });
      return;
    }

    if (args.result.kind === "canceled") {
      await ctx.db.patch(job._id, {
        status: "canceled",
        completedAt: Date.now(),
        workflowId: args.workflowId,
        lastHeartbeatAt: Date.now(),
      });
      return;
    }

    await ctx.db.patch(job._id, {
      status: "failed",
      completedAt: Date.now(),
      error: args.result.error,
      workflowId: args.workflowId,
      lastHeartbeatAt: Date.now(),
    });
  },
});

export const syncConnection = action({
  args: {
    connectionId: v.id("connections"),
    provider: providerName,
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    syncWindowHours: v.optional(v.number()),
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
    subscriptionKey: v.optional(v.string()),
  },
  returns: v.object({
    syncJobId: v.string(),
    workflowId: v.string(),
    deduped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.runQuery(internal.connections.getById, {
      connectionId: args.connectionId,
    });
    if (!connection) {
      throw new Error(`Connection ${args.connectionId} not found`);
    }
    if (connection.provider !== args.provider) {
      throw new Error(
        `Connection ${args.connectionId} does not belong to provider "${args.provider}"`,
      );
    }

    if ((args.clientId && !args.clientSecret) || (!args.clientId && args.clientSecret)) {
      throw new Error("clientId and clientSecret must be provided together");
    }

    if (args.clientId && args.clientSecret) {
      await ctx.runMutation(internal.providerSettings.upsertCredentials, {
        provider: args.provider,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        subscriptionKey: args.subscriptionKey,
      });
    }

    const endDate = args.endDate ?? Date.now();
    const defaultWindowMs = (args.syncWindowHours ?? DEFAULT_SYNC_WINDOW_HOURS) * 60 * 60 * 1000;
    const startDate =
      args.startDate ??
      Math.max(connection.lastSyncedAt ?? endDate - defaultWindowMs, endDate - defaultWindowMs);

    const result = await ctx.runMutation(internal.syncWorkflow.requestConnectionSync, {
      connectionId: args.connectionId,
      mode: "manual",
      triggerSource: "manual:syncConnection",
      windowStart: startDate,
      windowEnd: endDate,
    });

    return {
      syncJobId: String(result.syncJobId),
      workflowId: result.workflowId,
      deduped: result.deduped,
    };
  },
});

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
    syncWindowHours: v.optional(v.number()),
  },
  returns: v.object({
    enqueued: v.number(),
    deduped: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    const activeConnections = await ctx.runQuery(internal.connections.getAllActive, {});
    const endDate = Date.now();
    let enqueued = 0;
    let deduped = 0;
    let skipped = 0;

    for (const conn of activeConnections) {
      const creds = args.clientCredentials[conn.provider as keyof typeof args.clientCredentials];
      if (creds) {
        await ctx.runMutation(internal.providerSettings.upsertCredentials, {
          provider: conn.provider,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          subscriptionKey: "subscriptionKey" in creds ? creds.subscriptionKey : undefined,
        });
      } else {
        const stored = await ctx.runQuery(internal.providerSettings.getCredentials, {
          provider: conn.provider,
        });
        if (!stored) {
          skipped += 1;
          continue;
        }
      }

      if (!getProvider(conn.provider)) {
        skipped += 1;
        continue;
      }

      const windowMs = (args.syncWindowHours ?? DEFAULT_SYNC_WINDOW_HOURS) * 60 * 60 * 1000;
      const startDate = Math.max(conn.lastSyncedAt ?? endDate - windowMs, endDate - windowMs);

      try {
        const result = await ctx.runMutation(internal.syncWorkflow.requestConnectionSync, {
          connectionId: conn._id,
          mode: "cron",
          triggerSource: "cron:syncAllActive",
          windowStart: startDate,
          windowEnd: endDate,
        });

        if (result.deduped) {
          deduped += 1;
        } else {
          enqueued += 1;
        }
      } catch {
        skipped += 1;
      }
    }

    return { enqueued, deduped, skipped };
  },
});
