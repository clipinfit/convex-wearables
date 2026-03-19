import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

async function seedDataSource(
  t: ReturnType<typeof convexTest>,
  userId = "user-1",
  provider: "garmin" | "strava" = "garmin",
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("dataSources", {
      userId,
      provider,
      deviceModel: "Forerunner 965",
      source: "garmin-api",
    });
  });
}

describe("events", () => {
  describe("storeEvent", () => {
    it("creates a new workout event", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      const eventId = await t.run(async (ctx) => {
        return await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "running",
          startDatetime: 1710000000000,
          endDatetime: 1710003600000,
          durationSeconds: 3600,
          distance: 10000,
          heartRateAvg: 145,
          energyBurned: 750,
        });
      });

      expect(eventId).toBeDefined();

      const event = await t.run(async (ctx) => {
        return await ctx.db.get(eventId);
      });
      expect(event).toMatchObject({
        category: "workout",
        type: "running",
        distance: 10000,
        heartRateAvg: 145,
      });
    });

    it("creates a sleep event with stages", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      const eventId = await t.run(async (ctx) => {
        return await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "sleep",
          type: "night_sleep",
          startDatetime: 1710010000000,
          endDatetime: 1710040000000,
          sleepTotalDurationMinutes: 480,
          sleepDeepMinutes: 90,
          sleepRemMinutes: 120,
          sleepLightMinutes: 200,
          sleepAwakeMinutes: 70,
          sleepEfficiencyScore: 85.5,
          sleepStages: [
            { stage: "light", startTime: 1710010000000, endTime: 1710015000000 },
            { stage: "deep", startTime: 1710015000000, endTime: 1710020000000 },
            { stage: "rem", startTime: 1710020000000, endTime: 1710025000000 },
          ],
        });
      });

      const event = await t.run(async (ctx) => {
        return await ctx.db.get(eventId);
      });
      expect(event?.sleepStages).toHaveLength(3);
      expect(event?.sleepDeepMinutes).toBe(90);
    });

    it("deduplicates by externalId via index lookup", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      // Insert first
      const id1 = await t.run(async (ctx) => {
        return await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "running",
          startDatetime: 1710000000000,
          externalId: "strava-123",
          distance: 5000,
        });
      });

      // "Upsert" — find by externalId, patch
      await t.run(async (ctx) => {
        const existing = await ctx.db
          .query("events")
          .withIndex("by_external_id", (idx) => idx.eq("externalId", "strava-123"))
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, { distance: 5500 });
        }
      });

      const event = await t.run(async (ctx) => {
        return await ctx.db.get(id1);
      });
      expect(event?.distance).toBe(5500);
    });

    it("deduplicates batch writes by source + start + end when externalId is missing", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "running",
          startDatetime: 1710000000000,
          endDatetime: 1710003600000,
          distance: 5000,
        });
      });

      await t.mutation(internal.events.storeEventBatch, {
        events: [
          {
            dataSourceId: dsId,
            userId: "user-1",
            category: "workout",
            type: "running",
            startDatetime: 1710000000000,
            endDatetime: 1710003600000,
            distance: 5500,
          },
        ],
      });

      const events = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx.eq("userId", "user-1").eq("category", "workout"),
          )
          .collect();
      });

      expect(events).toHaveLength(1);
      expect(events[0].distance).toBe(5500);
    });
  });

  describe("getEvents", () => {
    it("returns events filtered by category via index", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "running",
          startDatetime: 1710000000000,
        });
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "cycling",
          startDatetime: 1710100000000,
        });
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "sleep",
          type: "night_sleep",
          startDatetime: 1710050000000,
        });
      });

      const workouts = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx.eq("userId", "user-1").eq("category", "workout"),
          )
          .collect();
      });

      expect(workouts).toHaveLength(2);
    });

    it("filters by date range", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "running",
          startDatetime: 1710000000000,
        });
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "cycling",
          startDatetime: 1710100000000,
        });
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "swimming",
          startDatetime: 1710200000000,
        });
      });

      const filtered = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx
              .eq("userId", "user-1")
              .eq("category", "workout")
              .gte("startDatetime", 1710050000000)
              .lte("startDatetime", 1710150000000),
          )
          .collect();
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].type).toBe("cycling");
    });

    it("paginates results with take()", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i++) {
          await ctx.db.insert("events", {
            dataSourceId: dsId,
            userId: "user-1",
            category: "workout",
            type: `run-${i}`,
            startDatetime: 1710000000000 + i * 100000,
          });
        }
      });

      const page1 = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx.eq("userId", "user-1").eq("category", "workout"),
          )
          .order("desc")
          .take(3);
      });

      expect(page1).toHaveLength(3);
      // Most recent first
      expect(page1[0].type).toBe("run-4");
      expect(page1[2].type).toBe("run-2");

      // Next page: events before the last one in page1
      const page2 = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx
              .eq("userId", "user-1")
              .eq("category", "workout")
              .lt("startDatetime", page1[2].startDatetime),
          )
          .order("desc")
          .take(3);
      });

      expect(page2).toHaveLength(2);
      expect(page2[0].type).toBe("run-1");
      expect(page2[1].type).toBe("run-0");
    });

    it("isolates data between users", async () => {
      const t = convexTest(schema, modules);
      const ds1 = await seedDataSource(t, "user-1");
      const ds2 = await seedDataSource(t, "user-2", "strava");

      await t.run(async (ctx) => {
        await ctx.db.insert("events", {
          dataSourceId: ds1,
          userId: "user-1",
          category: "workout",
          type: "running",
          startDatetime: 1710000000000,
        });
        await ctx.db.insert("events", {
          dataSourceId: ds2,
          userId: "user-2",
          category: "workout",
          type: "cycling",
          startDatetime: 1710000000000,
        });
      });

      const user1 = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx.eq("userId", "user-1").eq("category", "workout"),
          )
          .collect();
      });
      const user2 = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx.eq("userId", "user-2").eq("category", "workout"),
          )
          .collect();
      });

      expect(user1).toHaveLength(1);
      expect(user1[0].type).toBe("running");
      expect(user2).toHaveLength(1);
      expect(user2[0].type).toBe("cycling");
    });

    it("deduplicates by source + start + end via index", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("events", {
          dataSourceId: dsId,
          userId: "user-1",
          category: "workout",
          type: "cycling",
          startDatetime: 1710000000000,
          endDatetime: 1710003600000,
        });
      });

      // Check if duplicate exists before inserting
      const exists = await t.run(async (ctx) => {
        return await ctx.db
          .query("events")
          .withIndex("by_source_start_end", (idx) =>
            idx
              .eq("dataSourceId", dsId)
              .eq("startDatetime", 1710000000000)
              .eq("endDatetime", 1710003600000),
          )
          .first();
      });

      expect(exists).not.toBeNull();
      expect(exists?.type).toBe("cycling");
    });
  });
});
