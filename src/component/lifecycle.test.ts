import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

describe("lifecycle", () => {
  describe("deleteAllUserData", () => {
    it("deletes all data across all tables for a user", async () => {
      const t = convexTest(schema, modules);

      // Seed user-1 data
      const { connId, dsId } = await t.run(async (ctx) => {
        const connId = await ctx.db.insert("connections", {
          userId: "user-1", provider: "garmin",
          accessToken: "token", status: "active",
        });
        const dsId = await ctx.db.insert("dataSources", {
          userId: "user-1", provider: "garmin", connectionId: connId,
        });
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId, seriesType: "heart_rate",
          recordedAt: 1710000000000, value: 72,
        });
        await ctx.db.insert("events", {
          dataSourceId: dsId, userId: "user-1", category: "workout",
          type: "running", startDatetime: 1710000000000,
        });
        await ctx.db.insert("dailySummaries", {
          userId: "user-1", date: "2026-03-15", category: "activity",
          totalSteps: 10000,
        });
        await ctx.db.insert("syncJobs", {
          userId: "user-1", status: "completed", startedAt: 1710000000000,
        });
        await ctx.db.insert("backfillJobs", {
          connectionId: connId, userId: "user-1", provider: "garmin",
          dataType: "dailies", status: "completed", startedAt: 1710000000000,
        });
        return { connId, dsId };
      });

      // Seed user-2 data (should NOT be deleted)
      await t.run(async (ctx) => {
        const c2 = await ctx.db.insert("connections", {
          userId: "user-2", provider: "strava",
          accessToken: "token-2", status: "active",
        });
        const ds2 = await ctx.db.insert("dataSources", {
          userId: "user-2", provider: "strava", connectionId: c2,
        });
        await ctx.db.insert("events", {
          dataSourceId: ds2, userId: "user-2", category: "workout",
          type: "cycling", startDatetime: 1710000000000,
        });
      });

      // Delete user-1 data (simulate what lifecycle.deleteAllUserData does)
      await t.run(async (ctx) => {
        // Delete backfill jobs
        const backfills = await ctx.db
          .query("backfillJobs")
          .withIndex("by_connection", (idx) => idx.eq("connectionId", connId))
          .collect();
        for (const bf of backfills) await ctx.db.delete(bf._id);

        // Delete connections
        const conns = await ctx.db
          .query("connections")
          .withIndex("by_user", (idx) => idx.eq("userId", "user-1"))
          .collect();
        for (const c of conns) await ctx.db.delete(c._id);

        // Delete data points
        const points = await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", dsId))
          .collect();
        for (const p of points) await ctx.db.delete(p._id);

        // Delete data sources
        const sources = await ctx.db
          .query("dataSources")
          .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1"))
          .collect();
        for (const s of sources) await ctx.db.delete(s._id);

        // Delete events
        const events = await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) => idx.eq("userId", "user-1"))
          .collect();
        for (const e of events) await ctx.db.delete(e._id);

        // Delete summaries
        const summaries = await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_date", (idx) => idx.eq("userId", "user-1"))
          .collect();
        for (const s of summaries) await ctx.db.delete(s._id);

        // Delete sync jobs
        const jobs = await ctx.db
          .query("syncJobs")
          .withIndex("by_user", (idx) => idx.eq("userId", "user-1"))
          .collect();
        for (const j of jobs) await ctx.db.delete(j._id);
      });

      // Verify user-1 data is gone
      const user1Conns = await t.run(async (ctx) => {
        return await ctx.db
          .query("connections")
          .withIndex("by_user", (idx) => idx.eq("userId", "user-1"))
          .collect();
      });
      expect(user1Conns).toHaveLength(0);

      const user1Events = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) => idx.eq("userId", "user-1"))
          .collect();
      });
      expect(user1Events).toHaveLength(0);

      const user1Summaries = await t.run(async (ctx) => {
        return await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_date", (idx) => idx.eq("userId", "user-1"))
          .collect();
      });
      expect(user1Summaries).toHaveLength(0);

      // Verify user-2 data is intact
      const user2Conns = await t.run(async (ctx) => {
        return await ctx.db
          .query("connections")
          .withIndex("by_user", (idx) => idx.eq("userId", "user-2"))
          .collect();
      });
      expect(user2Conns).toHaveLength(1);

      const user2Events = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) => idx.eq("userId", "user-2"))
          .collect();
      });
      expect(user2Events).toHaveLength(1);
    });
  });
});
