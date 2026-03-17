import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

describe("summaries", () => {
  describe("upsert", () => {
    it("creates a new daily summary", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        await ctx.db.insert("dailySummaries", {
          userId: "user-1",
          date: "2026-03-15",
          category: "activity",
          totalSteps: 10000,
          totalCalories: 2500,
          activeMinutes: 45,
          avgHeartRate: 72,
        });
      });

      const summaries = await t.run(async (ctx) => {
        return await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_category_date", (idx) =>
            idx.eq("userId", "user-1").eq("category", "activity")
              .gte("date", "2026-03-15").lte("date", "2026-03-15"),
          )
          .collect();
      });

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        totalSteps: 10000,
        totalCalories: 2500,
        activeMinutes: 45,
      });
    });

    it("supports upsert pattern (find then patch or insert)", async () => {
      const t = convexTest(schema, modules);

      // First insert
      await t.run(async (ctx) => {
        await ctx.db.insert("dailySummaries", {
          userId: "user-1", date: "2026-03-15",
          category: "activity", totalSteps: 5000,
        });
      });

      // Upsert: find existing, patch it
      await t.run(async (ctx) => {
        const existing = await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_category_date", (idx) =>
            idx.eq("userId", "user-1").eq("category", "activity").eq("date", "2026-03-15"),
          )
          .first();

        if (existing) {
          await ctx.db.patch(existing._id, { totalSteps: 10000, activeMinutes: 45 });
        }
      });

      const summaries = await t.run(async (ctx) => {
        return await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_category_date", (idx) =>
            idx.eq("userId", "user-1").eq("category", "activity"),
          )
          .collect();
      });

      expect(summaries).toHaveLength(1);
      expect(summaries[0].totalSteps).toBe(10000);
      expect(summaries[0].activeMinutes).toBe(45);
    });
  });

  describe("getDailySummaries", () => {
    it("returns summaries within date range", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        for (let day = 10; day <= 16; day++) {
          await ctx.db.insert("dailySummaries", {
            userId: "user-1",
            date: `2026-03-${day}`,
            category: "activity",
            totalSteps: 8000 + day * 100,
          });
        }
      });

      const result = await t.run(async (ctx) => {
        return await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_category_date", (idx) =>
            idx.eq("userId", "user-1").eq("category", "activity")
              .gte("date", "2026-03-12").lte("date", "2026-03-14"),
          )
          .collect();
      });

      expect(result).toHaveLength(3);
      expect(result[0].date).toBe("2026-03-12");
      expect(result[2].date).toBe("2026-03-14");
    });

    it("separates categories", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        await ctx.db.insert("dailySummaries", {
          userId: "user-1", date: "2026-03-15",
          category: "activity", totalSteps: 10000,
        });
        await ctx.db.insert("dailySummaries", {
          userId: "user-1", date: "2026-03-15",
          category: "sleep", sleepDurationMinutes: 480,
        });
      });

      const activity = await t.run(async (ctx) => {
        return await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_category_date", (idx) =>
            idx.eq("userId", "user-1").eq("category", "activity"),
          )
          .collect();
      });
      const sleep = await t.run(async (ctx) => {
        return await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_category_date", (idx) =>
            idx.eq("userId", "user-1").eq("category", "sleep"),
          )
          .collect();
      });

      expect(activity).toHaveLength(1);
      expect(activity[0].totalSteps).toBe(10000);
      expect(sleep).toHaveLength(1);
      expect(sleep[0].sleepDurationMinutes).toBe(480);
    });
  });

  describe("getByUserDate", () => {
    it("returns all categories for a date", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        await ctx.db.insert("dailySummaries", {
          userId: "user-1", date: "2026-03-15",
          category: "activity", totalSteps: 10000,
        });
        await ctx.db.insert("dailySummaries", {
          userId: "user-1", date: "2026-03-15",
          category: "sleep", sleepDurationMinutes: 480,
        });
        await ctx.db.insert("dailySummaries", {
          userId: "user-1", date: "2026-03-15",
          category: "recovery", restingHeartRate: 55, hrvAvg: 65,
        });
      });

      const all = await t.run(async (ctx) => {
        return await ctx.db
          .query("dailySummaries")
          .withIndex("by_user_date", (idx) =>
            idx.eq("userId", "user-1").eq("date", "2026-03-15"),
          )
          .collect();
      });

      expect(all).toHaveLength(3);
      const categories = all.map((s) => s.category);
      expect(categories).toContain("activity");
      expect(categories).toContain("sleep");
      expect(categories).toContain("recovery");
    });
  });
});
