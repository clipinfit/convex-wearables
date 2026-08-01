import { v } from "convex/values";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { storePointsWithPolicy } from "./dataPoints";
import { assertIngestionAllowed } from "./lifecycle";
import { buildSyntheticDataPlan } from "./syntheticData";

const SYNTHETIC_PROVIDER = "synthetic" as const;
const SYNTHETIC_SOURCE = "synthetic";
const SYNTHETIC_DEVICE_MODEL = "SynthDevice";

const syntheticProfile = v.union(
  v.literal("active"),
  v.literal("sedentary"),
  v.literal("recovery"),
  v.literal("mixed"),
  v.literal("showcase"),
);

const clearCountsValidator = v.object({
  connections: v.number(),
  dataSources: v.number(),
  events: v.number(),
  dataPoints: v.number(),
  rollups: v.number(),
  seriesStates: v.number(),
  summaries: v.number(),
  syncJobs: v.number(),
});

type ClearCounts = {
  connections: number;
  dataSources: number;
  events: number;
  dataPoints: number;
  rollups: number;
  seriesStates: number;
  summaries: number;
  syncJobs: number;
};

function emptyClearCounts(): ClearCounts {
  return {
    connections: 0,
    dataSources: 0,
    events: 0,
    dataPoints: 0,
    rollups: 0,
    seriesStates: 0,
    summaries: 0,
    syncJobs: 0,
  };
}

async function clearSyntheticProviderData(ctx: MutationCtx, userId: string) {
  const counts = emptyClearCounts();
  const connection = await ctx.db
    .query("connections")
    .withIndex("by_user_provider", (index) =>
      index.eq("userId", userId).eq("provider", SYNTHETIC_PROVIDER),
    )
    .first();
  const sources = connection
    ? await ctx.db
        .query("dataSources")
        .withIndex("by_connection", (index) => index.eq("connectionId", connection._id))
        .collect()
    : [];

  for (const source of sources) {
    const [events, dataPoints, rollups, seriesStates] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_source_category_time", (index) => index.eq("dataSourceId", source._id))
        .collect(),
      ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (index) => index.eq("dataSourceId", source._id))
        .collect(),
      ctx.db
        .query("timeSeriesRollups")
        .withIndex("by_source_type_bucket", (index) => index.eq("dataSourceId", source._id))
        .collect(),
      ctx.db
        .query("timeSeriesSeriesState")
        .withIndex("by_source_series", (index) => index.eq("dataSourceId", source._id))
        .collect(),
    ]);

    for (const event of events) await ctx.db.delete(event._id);
    for (const point of dataPoints) await ctx.db.delete(point._id);
    for (const rollup of rollups) await ctx.db.delete(rollup._id);
    for (const state of seriesStates) await ctx.db.delete(state._id);

    counts.events += events.length;
    counts.dataPoints += dataPoints.length;
    counts.rollups += rollups.length;
    counts.seriesStates += seriesStates.length;
  }

  const summaries = await ctx.db
    .query("dailySummaries")
    .withIndex("by_user_provider_date", (index) =>
      index.eq("userId", userId).eq("provider", SYNTHETIC_PROVIDER),
    )
    .collect();
  const syncJobs = connection
    ? await ctx.db
        .query("syncJobs")
        .withIndex("by_connection", (index) => index.eq("connectionId", connection._id))
        .collect()
    : [];

  for (const summary of summaries) await ctx.db.delete(summary._id);
  for (const job of syncJobs) await ctx.db.delete(job._id);
  for (const source of sources) await ctx.db.delete(source._id);
  if (connection) await ctx.db.delete(connection._id);

  counts.summaries = summaries.length;
  counts.syncJobs = syncJobs.length;
  counts.dataSources = sources.length;
  counts.connections = connection ? 1 : 0;
  return counts;
}

export const seed = mutation({
  args: {
    userId: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    timezone: v.string(),
    asOf: v.optional(v.number()),
    profile: v.optional(syntheticProfile),
    seed: v.optional(v.string()),
    replaceExisting: v.optional(v.boolean()),
  },
  returns: v.object({
    connectionId: v.id("connections"),
    dataSourceId: v.id("dataSources"),
    syncJobId: v.id("syncJobs"),
    startDate: v.string(),
    endDate: v.string(),
    eventsStored: v.number(),
    dataPointsStored: v.number(),
    summariesStored: v.number(),
    lastSyncedAt: v.number(),
    cleared: clearCountsValidator,
  }),
  handler: async (ctx, args) => {
    await assertIngestionAllowed(ctx, { userId: args.userId, provider: SYNTHETIC_PROVIDER });
    const asOf = args.asOf ?? Date.now();
    const plan = buildSyntheticDataPlan({
      userId: args.userId,
      startDate: args.startDate,
      endDate: args.endDate,
      timezone: args.timezone,
      asOf,
      profile: args.profile ?? "mixed",
      seed: args.seed?.trim() || `${args.userId}:${args.startDate}`,
    });
    const existing = await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (index) =>
        index.eq("userId", args.userId).eq("provider", SYNTHETIC_PROVIDER),
      )
      .first();
    if (existing && !args.replaceExisting) {
      throw new Error(
        "Synthetic provider data already exists. Pass replaceExisting: true to regenerate it.",
      );
    }

    const cleared = existing
      ? await clearSyntheticProviderData(ctx, args.userId)
      : emptyClearCounts();
    const startedAt = Date.now();
    const connectionId = await ctx.db.insert("connections", {
      userId: args.userId,
      provider: SYNTHETIC_PROVIDER,
      providerUserId: `synthetic:${args.userId}`,
      providerUsername: "Synthetic test user",
      status: "active",
    });
    const dataSourceId = await ctx.db.insert("dataSources", {
      userId: args.userId,
      provider: SYNTHETIC_PROVIDER,
      connectionId,
      deviceModel: SYNTHETIC_DEVICE_MODEL,
      softwareVersion: "1",
      source: SYNTHETIC_SOURCE,
      deviceType: "watch",
      originalSourceName: SYNTHETIC_DEVICE_MODEL,
    });

    for (const event of plan.events) {
      await ctx.db.insert("events", {
        ...event,
        dataSourceId,
        userId: args.userId,
      });
    }

    const pointsBySeries = new Map<
      string,
      Array<{ recordedAt: number; value: number; externalId: string }>
    >();
    for (const point of plan.points) {
      const points = pointsBySeries.get(point.seriesType) ?? [];
      points.push({
        recordedAt: point.recordedAt,
        value: point.value,
        externalId: point.externalId,
      });
      pointsBySeries.set(point.seriesType, points);
    }
    for (const [seriesType, points] of pointsBySeries) {
      await storePointsWithPolicy(ctx, { dataSourceId, seriesType, points });
    }

    for (const summary of plan.summaries) {
      await ctx.db.insert("dailySummaries", {
        userId: args.userId,
        provider: SYNTHETIC_PROVIDER,
        dataSourceId,
        source: SYNTHETIC_SOURCE,
        originalSourceName: SYNTHETIC_DEVICE_MODEL,
        ...summary,
      });
    }

    const lastSyncedAt = Date.now();
    await ctx.db.patch(connectionId, { lastSyncedAt });
    const syncJobId = await ctx.db.insert("syncJobs", {
      connectionId,
      userId: args.userId,
      provider: SYNTHETIC_PROVIDER,
      mode: "manual",
      triggerSource: "synthetic:seed",
      idempotencyKey: `synthetic:${args.userId}:${args.startDate}:${args.endDate}:${startedAt}`,
      status: "completed",
      startedAt,
      completedAt: lastSyncedAt,
      recordsProcessed: plan.events.length + plan.points.length + plan.summaries.length,
      windowStart: Date.parse(`${args.startDate}T00:00:00.000Z`),
      windowEnd: Math.min(asOf, Date.parse(`${args.endDate}T23:59:59.999Z`)),
      attempt: 1,
    });

    return {
      connectionId,
      dataSourceId,
      syncJobId,
      startDate: args.startDate,
      endDate: args.endDate,
      eventsStored: plan.events.length,
      dataPointsStored: plan.points.length,
      summariesStored: plan.summaries.length,
      lastSyncedAt,
      cleared,
    };
  },
});

export const clear = mutation({
  args: { userId: v.string() },
  returns: clearCountsValidator,
  handler: async (ctx, args) => await clearSyntheticProviderData(ctx, args.userId),
});

export const status = query({
  args: { userId: v.string() },
  returns: v.object({
    exists: v.boolean(),
    connectionId: v.union(v.id("connections"), v.null()),
    lastSyncedAt: v.union(v.number(), v.null()),
    startDate: v.union(v.string(), v.null()),
    endDate: v.union(v.string(), v.null()),
    counts: v.object({
      connections: v.number(),
      dataSources: v.number(),
      events: v.number(),
      dataPoints: v.number(),
      rollups: v.number(),
      seriesStates: v.number(),
      summaries: v.number(),
      syncJobs: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (index) =>
        index.eq("userId", args.userId).eq("provider", SYNTHETIC_PROVIDER),
      )
      .first();
    if (!connection) {
      return {
        exists: false,
        connectionId: null,
        lastSyncedAt: null,
        startDate: null,
        endDate: null,
        counts: {
          connections: 0,
          dataSources: 0,
          events: 0,
          dataPoints: 0,
          rollups: 0,
          seriesStates: 0,
          summaries: 0,
          syncJobs: 0,
        },
      };
    }

    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_connection", (index) => index.eq("connectionId", connection._id))
      .collect();
    let eventCount = 0;
    let dataPointCount = 0;
    let rollupCount = 0;
    let seriesStateCount = 0;
    for (const source of sources) {
      const [events, points, rollups, seriesStates] = await Promise.all([
        ctx.db
          .query("events")
          .withIndex("by_source_category_time", (index) => index.eq("dataSourceId", source._id))
          .collect(),
        ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (index) => index.eq("dataSourceId", source._id))
          .collect(),
        ctx.db
          .query("timeSeriesRollups")
          .withIndex("by_source_type_bucket", (index) => index.eq("dataSourceId", source._id))
          .collect(),
        ctx.db
          .query("timeSeriesSeriesState")
          .withIndex("by_source_series", (index) => index.eq("dataSourceId", source._id))
          .collect(),
      ]);
      eventCount += events.length;
      dataPointCount += points.length;
      rollupCount += rollups.length;
      seriesStateCount += seriesStates.length;
    }
    const summaries = await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_provider_date", (index) =>
        index.eq("userId", args.userId).eq("provider", SYNTHETIC_PROVIDER),
      )
      .collect();
    const syncJobs = await ctx.db
      .query("syncJobs")
      .withIndex("by_connection", (index) => index.eq("connectionId", connection._id))
      .collect();
    const dates = summaries.map((summary) => summary.date).sort();

    return {
      exists: true,
      connectionId: connection._id,
      lastSyncedAt: connection.lastSyncedAt ?? null,
      startDate: dates[0] ?? null,
      endDate: dates[dates.length - 1] ?? null,
      counts: {
        connections: 1,
        dataSources: sources.length,
        events: eventCount,
        dataPoints: dataPointCount,
        rollups: rollupCount,
        seriesStates: seriesStateCount,
        summaries: summaries.length,
        syncJobs: syncJobs.length,
      },
    };
  },
});
