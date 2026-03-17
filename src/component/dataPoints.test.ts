import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

async function seedDataSource(t: ReturnType<typeof convexTest>, userId = "user-1", provider: "garmin" | "strava" = "garmin") {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("dataSources", {
      userId, provider,
      deviceModel: "Forerunner 965",
      source: "garmin-api",
    });
  });
}

describe("dataPoints", () => {
  describe("store and query", () => {
    it("stores and retrieves a data point", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId, seriesType: "heart_rate",
          recordedAt: 1710000000000, value: 72,
        });
      });

      const points = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
          )
          .collect();
      });

      expect(points).toHaveLength(1);
      expect(points[0].value).toBe(72);
    });

    it("deduplicates by source + type + time (upsert pattern)", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId, seriesType: "heart_rate",
          recordedAt: 1710000000000, value: 72,
        });
      });

      // Upsert: find existing, update value
      await t.run(async (ctx) => {
        const existing = await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate")
              .eq("recordedAt", 1710000000000),
          )
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, { value: 75 });
        }
      });

      const points = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
          )
          .collect();
      });

      expect(points).toHaveLength(1);
      expect(points[0].value).toBe(75);
    });
  });

  describe("time-series queries", () => {
    it("returns data within date range", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 10; i++) {
          await ctx.db.insert("dataPoints", {
            dataSourceId: dsId, seriesType: "heart_rate",
            recordedAt: 1710000000000 + i * 60000, value: 70 + i,
          });
        }
      });

      const result = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate")
              .gte("recordedAt", 1710000000000)
              .lte("recordedAt", 1710000300000),
          )
          .collect();
      });

      expect(result).toHaveLength(6); // 0,1,2,3,4,5 minutes
      expect(result[0].value).toBe(70);
      expect(result[5].value).toBe(75);
    });

    it("paginates with take()", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await ctx.db.insert("dataPoints", {
            dataSourceId: dsId, seriesType: "steps",
            recordedAt: 1710000000000 + i * 60000, value: 100 + i,
          });
        }
      });

      const page1 = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "steps")
              .gte("recordedAt", 1710000000000)
              .lte("recordedAt", 1710001200000),
          )
          .take(5);
      });

      expect(page1).toHaveLength(5);

      // Next page starts after last item
      const lastTime = page1[page1.length - 1].recordedAt;
      const page2 = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "steps")
              .gt("recordedAt", lastTime)
              .lte("recordedAt", 1710001200000),
          )
          .take(5);
      });

      expect(page2).toHaveLength(5);
      expect(page2[0].recordedAt).toBeGreaterThan(lastTime);
    });

    it("separates different series types", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId, seriesType: "heart_rate",
          recordedAt: 1710000000000, value: 72,
        });
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId, seriesType: "steps",
          recordedAt: 1710000000000, value: 150,
        });
      });

      const hr = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
          )
          .collect();
      });
      const steps = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "steps"),
          )
          .collect();
      });

      expect(hr).toHaveLength(1);
      expect(hr[0].value).toBe(72);
      expect(steps).toHaveLength(1);
      expect(steps[0].value).toBe(150);
    });
  });

  describe("latest data point", () => {
    it("finds the most recent value across sources", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId, seriesType: "weight",
          recordedAt: 1710000000000, value: 80.5,
        });
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId, seriesType: "weight",
          recordedAt: 1710100000000, value: 80.2,
        });
      });

      const latest = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "weight"),
          )
          .order("desc")
          .first();
      });

      expect(latest).not.toBeNull();
      expect(latest?.value).toBe(80.2);
      expect(latest?.recordedAt).toBe(1710100000000);
    });
  });

  describe("batch insert", () => {
    it("stores multiple data points", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 10; i++) {
          await ctx.db.insert("dataPoints", {
            dataSourceId: dsId, seriesType: "heart_rate",
            recordedAt: 1710000000000 + i * 60000, value: 70 + i,
          });
        }
      });

      const stored = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
          )
          .collect();
      });

      expect(stored).toHaveLength(10);
    });
  });
});
