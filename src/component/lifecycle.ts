import { v } from "convex/values";
import { mutation } from "./_generated/server";

/**
 * Delete ALL data for a user across all component tables.
 * Used for GDPR compliance and account deletion.
 *
 * This is a "best-effort" deletion within a single mutation.
 * For users with very large amounts of data, the host app should
 * call this repeatedly or use a workflow.
 */
export const deleteAllUserData = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const { userId } = args;

    // 1. Delete connections
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_user", (idx) => idx.eq("userId", userId))
      .collect();
    for (const conn of connections) {
      // Delete backfill jobs for this connection
      const backfills = await ctx.db
        .query("backfillJobs")
        .withIndex("by_connection", (idx) => idx.eq("connectionId", conn._id))
        .collect();
      for (const bf of backfills) {
        await ctx.db.delete(bf._id);
      }
      await ctx.db.delete(conn._id);
    }

    // 2. Delete data sources and their data points
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", userId))
      .collect();
    for (const source of sources) {
      // Delete data points in batches
      let points = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", source._id))
        .take(500);
      while (points.length > 0) {
        for (const p of points) {
          await ctx.db.delete(p._id);
        }
        points = await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", source._id))
          .take(500);
      }
      await ctx.db.delete(source._id);
    }

    // 3. Delete events
    const events = await ctx.db
      .query("events")
      .withIndex("by_user_category_time", (idx) => idx.eq("userId", userId))
      .collect();
    for (const event of events) {
      await ctx.db.delete(event._id);
    }

    // 4. Delete daily summaries
    const summaries = await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_date", (idx) => idx.eq("userId", userId))
      .collect();
    for (const summary of summaries) {
      await ctx.db.delete(summary._id);
    }

    // 5. Delete sync jobs
    const jobs = await ctx.db
      .query("syncJobs")
      .withIndex("by_user", (idx) => idx.eq("userId", userId))
      .collect();
    for (const job of jobs) {
      await ctx.db.delete(job._id);
    }
  },
});
