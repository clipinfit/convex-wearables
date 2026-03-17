import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get time-series data points with cursor-based pagination.
 * Uses the by_source_type_time index for efficient range queries.
 */
export const getTimeSeries = query({
  args: {
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: v.object({
    points: v.array(
      v.object({
        timestamp: v.number(),
        value: v.number(),
      }),
    ),
    nextCursor: v.union(v.string(), v.null()),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 500, 2000);
    const order = args.order ?? "asc";

    const startDate = args.cursor ? Number(args.cursor) : args.startDate;

    const results = await ctx.db
      .query("dataPoints")
      .withIndex("by_source_type_time", (idx) =>
        order === "asc"
          ? idx
              .eq("dataSourceId", args.dataSourceId)
              .eq("seriesType", args.seriesType)
              .gte("recordedAt", startDate)
              .lte("recordedAt", args.endDate)
          : idx
              .eq("dataSourceId", args.dataSourceId)
              .eq("seriesType", args.seriesType)
              .gte("recordedAt", args.startDate)
              .lte("recordedAt", startDate),
      )
      .order(order)
      .take(limit + 1);

    const hasMore = results.length > limit;
    const items = hasMore ? results.slice(0, limit) : results;
    const points = items.map((dp) => ({
      timestamp: dp.recordedAt,
      value: dp.value,
    }));
    const nextCursor =
      hasMore && items.length > 0 ? String(items[items.length - 1].recordedAt) : null;

    return { points, nextCursor, hasMore };
  },
});

/**
 * Get time-series data for a user across all their data sources for a given series type.
 * This is a user-facing query that resolves data sources internally.
 */
export const getTimeSeriesForUser = query({
  args: {
    userId: v.string(),
    seriesType: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      timestamp: v.number(),
      value: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 500, 2000);

    // Get all data sources for this user
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();

    // Collect data from all sources (merge and sort)
    const allPoints: { timestamp: number; value: number }[] = [];
    for (const source of sources) {
      const points = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) =>
          idx
            .eq("dataSourceId", source._id)
            .eq("seriesType", args.seriesType)
            .gte("recordedAt", args.startDate)
            .lte("recordedAt", args.endDate),
        )
        .take(limit);

      for (const dp of points) {
        allPoints.push({ timestamp: dp.recordedAt, value: dp.value });
      }
    }

    // Sort by timestamp and limit
    allPoints.sort((a, b) => a.timestamp - b.timestamp);
    return allPoints.slice(0, limit);
  },
});

/**
 * Get the latest data point for a user and series type.
 */
export const getLatestDataPoint = query({
  args: {
    userId: v.string(),
    seriesType: v.string(),
  },
  returns: v.union(
    v.object({
      timestamp: v.number(),
      value: v.number(),
      provider: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();

    let latest: { timestamp: number; value: number; provider: string } | null = null;

    for (const source of sources) {
      const point = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) =>
          idx.eq("dataSourceId", source._id).eq("seriesType", args.seriesType),
        )
        .order("desc")
        .first();

      if (point && (latest === null || point.recordedAt > latest.timestamp)) {
        latest = {
          timestamp: point.recordedAt,
          value: point.value,
          provider: source.provider,
        };
      }
    }

    return latest;
  },
});

/**
 * Get all available series types for a user (i.e., types that have at least one data point).
 */
export const getAvailableSeriesTypes = query({
  args: { userId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();

    const types = new Set<string>();

    for (const source of sources) {
      // Sample a few data points to discover types
      // This is efficient because we only need one per type
      const points = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", source._id))
        .take(200);

      for (const point of points) {
        types.add(point.seriesType);
      }
    }

    return Array.from(types).sort();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Store a single data point. Deduplicates by (source, type, time).
 */
export const storeDataPoint = internalMutation({
  args: {
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(),
    recordedAt: v.number(),
    value: v.number(),
    externalId: v.optional(v.string()),
  },
  returns: v.id("dataPoints"),
  handler: async (ctx, args) => {
    // Deduplicate by (source, type, time)
    const existing = await ctx.db
      .query("dataPoints")
      .withIndex("by_source_type_time", (idx) =>
        idx
          .eq("dataSourceId", args.dataSourceId)
          .eq("seriesType", args.seriesType)
          .eq("recordedAt", args.recordedAt),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { value: args.value });
      return existing._id;
    }

    return await ctx.db.insert("dataPoints", args);
  },
});

/**
 * Store a batch of data points. Used by sync workflows.
 * Must complete within 1 second — caller is responsible for batch sizing.
 */
export const storeBatch = internalMutation({
  args: {
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(),
    points: v.array(
      v.object({
        recordedAt: v.number(),
        value: v.number(),
        externalId: v.optional(v.string()),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    let count = 0;
    for (const point of args.points) {
      // Deduplicate by (source, type, time)
      const existing = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) =>
          idx
            .eq("dataSourceId", args.dataSourceId)
            .eq("seriesType", args.seriesType)
            .eq("recordedAt", point.recordedAt),
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, { value: point.value });
      } else {
        await ctx.db.insert("dataPoints", {
          dataSourceId: args.dataSourceId,
          seriesType: args.seriesType,
          recordedAt: point.recordedAt,
          value: point.value,
          externalId: point.externalId,
        });
      }
      count++;
    }
    return count;
  },
});

/**
 * Delete all data points for a data source. Used during user/connection cleanup.
 */
export const deleteByDataSource = internalMutation({
  args: { dataSourceId: v.id("dataSources") },
  handler: async (ctx, args) => {
    // Delete in batches to avoid hitting limits
    let batch = await ctx.db
      .query("dataPoints")
      .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", args.dataSourceId))
      .take(1000);

    while (batch.length > 0) {
      for (const dp of batch) {
        await ctx.db.delete(dp._id);
      }
      batch = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", args.dataSourceId))
        .take(1000);
    }
  },
});
