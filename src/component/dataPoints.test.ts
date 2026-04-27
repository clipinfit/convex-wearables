import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
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

describe("dataPoints", () => {
  describe("store and query", () => {
    it("stores and retrieves a data point", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId,
          seriesType: "heart_rate",
          recordedAt: 1710000000000,
          value: 72,
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
          dataSourceId: dsId,
          seriesType: "heart_rate",
          recordedAt: 1710000000000,
          value: 72,
        });
      });

      // Upsert: find existing, update value
      await t.run(async (ctx) => {
        const existing = await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx
              .eq("dataSourceId", dsId)
              .eq("seriesType", "heart_rate")
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

    it("upserts mixed replayed, changed, and new batch points", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);
      const firstRecordedAt = 1710000000000;
      const secondRecordedAt = firstRecordedAt + 60000;
      const thirdRecordedAt = firstRecordedAt + 120000;

      await t.mutation(internal.dataPoints.storeBatch, {
        dataSourceId: dsId,
        seriesType: "heart_rate",
        points: [
          { recordedAt: firstRecordedAt, value: 72, externalId: "hr-1" },
          { recordedAt: secondRecordedAt, value: 74, externalId: "hr-2" },
        ],
      });

      await t.mutation(internal.dataPoints.storeBatch, {
        dataSourceId: dsId,
        seriesType: "heart_rate",
        points: [
          { recordedAt: firstRecordedAt, value: 72, externalId: "hr-1" },
          { recordedAt: secondRecordedAt, value: 75, externalId: "hr-2b" },
          { recordedAt: thirdRecordedAt, value: 76, externalId: "hr-3" },
        ],
      });

      const points = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
          )
          .collect();
      });

      expect(points).toHaveLength(3);
      expect(points.map((point) => point.value)).toEqual([72, 75, 76]);
      expect(points.map((point) => point.externalId)).toEqual(["hr-1", "hr-2b", "hr-3"]);
    });
  });

  describe("time-series queries", () => {
    it("returns data within date range", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 10; i++) {
          await ctx.db.insert("dataPoints", {
            dataSourceId: dsId,
            seriesType: "heart_rate",
            recordedAt: 1710000000000 + i * 60000,
            value: 70 + i,
          });
        }
      });

      const result = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx
              .eq("dataSourceId", dsId)
              .eq("seriesType", "heart_rate")
              .gte("recordedAt", 1710000000000)
              .lte("recordedAt", 1710000300000),
          )
          .collect();
      });

      expect(result).toHaveLength(6); // 0,1,2,3,4,5 minutes
      expect(result[0].value).toBe(70);
      expect(result[5].value).toBe(75);
    });

    it("limits user time series to the latest points by default", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t, "user-latest");
      const start = Date.parse("2026-04-27T08:00:00Z");

      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i++) {
          await ctx.db.insert("dataPoints", {
            dataSourceId: dsId,
            seriesType: "heart_rate",
            recordedAt: start + i * 60 * 1000,
            value: 70 + i,
          });
        }
      });

      const latestChronological = await t.query(api.dataPoints.getTimeSeriesForUser, {
        userId: "user-latest",
        seriesType: "heart_rate",
        startDate: start,
        endDate: start + 4 * 60 * 1000,
        limit: 2,
      });

      expect(latestChronological.map((point: { timestamp: number }) => point.timestamp)).toEqual([
        start + 3 * 60 * 1000,
        start + 4 * 60 * 1000,
      ]);
      expect(latestChronological.map((point: { value: number }) => point.value)).toEqual([73, 74]);

      const oldestChronological = await t.query(api.dataPoints.getTimeSeriesForUser, {
        userId: "user-latest",
        seriesType: "heart_rate",
        startDate: start,
        endDate: start + 4 * 60 * 1000,
        limit: 2,
        order: "asc",
      });

      expect(oldestChronological.map((point: { timestamp: number }) => point.timestamp)).toEqual([
        start,
        start + 60 * 1000,
      ]);

      const latestDescending = await t.query(api.dataPoints.getTimeSeriesForUser, {
        userId: "user-latest",
        seriesType: "heart_rate",
        startDate: start,
        endDate: start + 4 * 60 * 1000,
        limit: 2,
        order: "desc",
      });

      expect(latestDescending.map((point: { timestamp: number }) => point.timestamp)).toEqual([
        start + 4 * 60 * 1000,
        start + 3 * 60 * 1000,
      ]);
    });

    it("paginates with take()", async () => {
      const t = convexTest(schema, modules);
      const dsId = await seedDataSource(t);

      await t.run(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await ctx.db.insert("dataPoints", {
            dataSourceId: dsId,
            seriesType: "steps",
            recordedAt: 1710000000000 + i * 60000,
            value: 100 + i,
          });
        }
      });

      const page1 = await t.run(async (ctx) => {
        return await ctx.db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx
              .eq("dataSourceId", dsId)
              .eq("seriesType", "steps")
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
            idx
              .eq("dataSourceId", dsId)
              .eq("seriesType", "steps")
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
          dataSourceId: dsId,
          seriesType: "heart_rate",
          recordedAt: 1710000000000,
          value: 72,
        });
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId,
          seriesType: "steps",
          recordedAt: 1710000000000,
          value: 150,
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
          dataSourceId: dsId,
          seriesType: "weight",
          recordedAt: 1710000000000,
          value: 80.5,
        });
        await ctx.db.insert("dataPoints", {
          dataSourceId: dsId,
          seriesType: "weight",
          recordedAt: 1710100000000,
          value: 80.2,
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
            dataSourceId: dsId,
            seriesType: "heart_rate",
            recordedAt: 1710000000000 + i * 60000,
            value: 70 + i,
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

  describe("storage policies", () => {
    it("persists tier policies, presets, and resolves precedence", async () => {
      const t = convexTest(schema, modules);

      const replaceResult = await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
        defaultRules: [
          {
            tiers: [{ kind: "raw", fromAge: "0m", toAge: null }],
          },
          {
            provider: "garmin",
            tiers: [
              { kind: "raw", fromAge: "0m", toAge: "7d" },
              {
                kind: "rollup",
                fromAge: "7d",
                toAge: null,
                bucket: "5m",
                aggregations: ["avg", "last"],
              },
            ],
          },
          {
            seriesType: "heart_rate",
            tiers: [
              { kind: "rollup", fromAge: "0m", toAge: null, bucket: "1m", aggregations: ["last"] },
            ],
          },
          {
            provider: "garmin",
            seriesType: "heart_rate",
            tiers: [
              { kind: "raw", fromAge: "0m", toAge: "24h" },
              {
                kind: "rollup",
                fromAge: "24h",
                toAge: "7d",
                bucket: "30m",
                aggregations: ["avg", "min", "max", "last", "count"],
              },
              {
                kind: "rollup",
                fromAge: "7d",
                toAge: null,
                bucket: "3h",
                aggregations: ["avg", "last", "count"],
              },
            ],
          },
        ],
        presets: [
          {
            key: "pro",
            rules: [
              {
                provider: "garmin",
                seriesType: "heart_rate",
                tiers: [
                  { kind: "raw", fromAge: "0m", toAge: "12h" },
                  { kind: "rollup", fromAge: "12h", toAge: "14d", bucket: "15m" },
                  { kind: "rollup", fromAge: "14d", toAge: null, bucket: "6h" },
                ],
              },
            ],
          },
        ],
        maintenance: {
          enabled: true,
          interval: "2h",
        },
      });

      expect(replaceResult).toEqual({
        defaultRulesStored: 4,
        presetsStored: 1,
      });

      const configuration = await t.query(api.dataPoints.getTimeSeriesPolicyConfiguration, {});
      expect(configuration.maintenance).toEqual({
        enabled: true,
        intervalMs: 2 * 60 * 60 * 1000,
      });
      expect(configuration.defaultRules).toHaveLength(4);
      expect(configuration.defaultRules.map((policy: { scope: string }) => policy.scope)).toEqual([
        "global",
        "provider",
        "series",
        "provider_series",
      ]);
      expect(configuration.presets).toHaveLength(1);
      expect(configuration.presets[0].key).toBe("pro");

      const exact = await t.query(api.dataPoints.getEffectiveTimeSeriesPolicy, {
        userId: "user-1",
        provider: "garmin",
        seriesType: "heart_rate",
      });
      expect(exact).toMatchObject({
        matchedScope: "provider_series",
        sourceKind: "default",
        sourceKey: "__default__",
      });
      expect(exact.tiers).toHaveLength(3);
      expect(exact.tiers[0]).toMatchObject({
        kind: "raw",
        fromAgeMs: 0,
        toAgeMs: 24 * 60 * 60 * 1000,
      });
      expect(exact.tiers[1]).toMatchObject({
        kind: "rollup",
        bucketMs: 30 * 60 * 1000,
      });

      const series = await t.query(api.dataPoints.getEffectiveTimeSeriesPolicy, {
        userId: "user-1",
        provider: "strava",
        seriesType: "heart_rate",
      });
      expect(series).toMatchObject({
        matchedScope: "series",
        sourceKind: "default",
      });
      expect(series.tiers).toEqual([
        {
          kind: "rollup",
          fromAgeMs: 0,
          toAgeMs: null,
          bucketMs: 60 * 1000,
          aggregations: ["last"],
        },
      ]);

      const provider = await t.query(api.dataPoints.getEffectiveTimeSeriesPolicy, {
        userId: "user-1",
        provider: "garmin",
        seriesType: "steps",
      });
      expect(provider).toMatchObject({
        matchedScope: "provider",
        sourceKind: "default",
      });
      expect(provider.tiers[1]).toMatchObject({
        kind: "rollup",
        bucketMs: 5 * 60 * 1000,
      });

      const fallback = await t.query(api.dataPoints.getEffectiveTimeSeriesPolicy, {
        userId: "user-1",
        provider: "polar",
        seriesType: "weight",
      });
      expect(fallback).toMatchObject({
        matchedScope: "global",
        sourceKind: "default",
      });
      expect(fallback.tiers).toEqual([
        {
          kind: "raw",
          fromAgeMs: 0,
          toAgeMs: null,
        },
      ]);

      await t.mutation(api.dataPoints.setUserTimeSeriesPolicyPreset, {
        userId: "user-1",
        presetKey: "pro",
      });

      const assignment = await t.query(api.dataPoints.getUserTimeSeriesPolicyPreset, {
        userId: "user-1",
      });
      expect(assignment).toMatchObject({
        userId: "user-1",
        presetKey: "pro",
      });

      const presetEffective = await t.query(api.dataPoints.getEffectiveTimeSeriesPolicy, {
        userId: "user-1",
        provider: "garmin",
        seriesType: "heart_rate",
      });
      expect(presetEffective).toMatchObject({
        sourceKind: "preset",
        sourceKey: "pro",
        matchedScope: "provider_series",
      });
      expect(presetEffective.tiers[1]).toMatchObject({
        kind: "rollup",
        bucketMs: 15 * 60 * 1000,
      });
    });

    it("stores older points in rollups and newer points as raw with explicit tiers", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-22T12:00:00Z"));

      try {
        const t = convexTest(schema, modules);
        const dsId = await seedDataSource(t, "user-1", "garmin");

        await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "24h" },
                { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
              ],
            },
          ],
        });

        await t.mutation(internal.dataPoints.storeBatch, {
          dataSourceId: dsId,
          seriesType: "heart_rate",
          points: [
            {
              recordedAt: Date.parse("2026-03-20T10:00:10Z"),
              value: 100,
            },
            {
              recordedAt: Date.parse("2026-03-20T10:10:00Z"),
              value: 120,
            },
            {
              recordedAt: Date.parse("2026-03-20T10:20:00Z"),
              value: 110,
            },
            {
              recordedAt: Date.parse("2026-03-22T11:30:00Z"),
              value: 70,
            },
            {
              recordedAt: Date.parse("2026-03-22T11:45:00Z"),
              value: 72,
            },
          ],
        });

        const rawPoints = await t.run(async (ctx) => {
          return await ctx.db
            .query("dataPoints")
            .withIndex("by_source_type_time", (idx) =>
              idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
            )
            .collect();
        });
        expect(rawPoints).toHaveLength(2);
        expect(rawPoints.map((point) => point.value)).toEqual([70, 72]);

        const rollups = await t.run(async (ctx) => {
          return await ctx.db
            .query("timeSeriesRollups")
            .withIndex("by_source_type_bucket", (idx) =>
              idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
            )
            .collect();
        });
        expect(rollups).toHaveLength(1);
        expect(rollups[0]).toMatchObject({
          count: 3,
          avg: 110,
          min: 100,
          max: 120,
          last: 110,
          bucketMs: 30 * 60 * 1000,
        });

        const points = await t.query(api.dataPoints.getTimeSeries, {
          dataSourceId: dsId,
          seriesType: "heart_rate",
          startDate: Date.parse("2026-03-20T10:00:00Z"),
          endDate: Date.parse("2026-03-22T12:00:00Z"),
        });

        expect(points.points).toHaveLength(3);
        expect(points.points[0]).toMatchObject({
          timestamp: Date.parse("2026-03-20T10:00:00Z"),
          value: 110,
          resolution: "rollup",
          bucketMinutes: 30,
          avg: 110,
          min: 100,
          max: 120,
          last: 110,
          count: 3,
        });
        expect(points.points[1]).toMatchObject({
          timestamp: Date.parse("2026-03-22T11:30:00Z"),
          value: 70,
          resolution: "raw",
        });
        expect(points.points[2]).toMatchObject({
          timestamp: Date.parse("2026-03-22T11:45:00Z"),
          value: 72,
          resolution: "raw",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("marks tiered series due for prompt scheduled maintenance without inline compaction", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-22T12:00:00Z"));

      try {
        const t = convexTest(schema, modules);
        const dsId = await seedDataSource(t, "user-due", "garmin");

        await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "24h" },
                { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
              ],
            },
          ],
          maintenance: {
            enabled: true,
            interval: "1h",
          },
        });

        await t.mutation(internal.dataPoints.storeBatch, {
          dataSourceId: dsId,
          seriesType: "heart_rate",
          points: [
            {
              recordedAt: Date.parse("2026-03-22T11:30:00Z"),
              value: 70,
            },
          ],
        });

        const state = await t.run(async (ctx) => {
          return await ctx.db
            .query("timeSeriesSeriesState")
            .withIndex("by_source_series", (idx) =>
              idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
            )
            .first();
        });

        expect(state?.nextMaintenanceAt).toBe(Date.parse("2026-03-22T12:00:00Z"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps maintenance due when a raw compaction batch has more backlog", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-22T12:00:00Z"));

      try {
        const t = convexTest(schema, modules);
        const dsId = await seedDataSource(t, "user-backlog", "garmin");
        const start = Date.parse("2026-03-20T00:00:00Z");

        await t.run(async (ctx) => {
          for (let i = 0; i < 2001; i++) {
            await ctx.db.insert("dataPoints", {
              dataSourceId: dsId,
              seriesType: "heart_rate",
              recordedAt: start + i * 60 * 1000,
              value: 80 + (i % 20),
            });
          }
          await ctx.db.insert("timeSeriesSeriesState", {
            dataSourceId: dsId,
            userId: "user-backlog",
            provider: "garmin",
            seriesType: "heart_rate",
            latestRecordedAt: start + 2000 * 60 * 1000,
            lastIngestedAt: Date.now(),
            nextMaintenanceAt: Date.now(),
            updatedAt: Date.now(),
          });
        });

        await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "24h" },
                { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
              ],
            },
          ],
          maintenance: {
            enabled: true,
            interval: "1h",
          },
        });

        await t.mutation(internal.dataPoints.runTimeSeriesMaintenance, {});

        const state = await t.run(async (ctx) => {
          return await ctx.db
            .query("timeSeriesSeriesState")
            .withIndex("by_source_series", (idx) =>
              idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
            )
            .first();
        });

        expect(state?.nextMaintenanceAt).toBe(Date.parse("2026-03-22T12:00:00Z"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("stores rollups only when a policy starts directly with a rollup tier", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-22T12:00:00Z"));

      try {
        const t = convexTest(schema, modules);
        const dsId = await seedDataSource(t, "user-summary", "garmin");

        await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                {
                  kind: "rollup",
                  fromAge: "0m",
                  toAge: null,
                  bucket: "5m",
                  aggregations: ["last"],
                },
              ],
            },
          ],
        });

        await t.mutation(internal.dataPoints.storeBatch, {
          dataSourceId: dsId,
          seriesType: "heart_rate",
          points: [
            {
              recordedAt: Date.parse("2026-03-20T10:00:00Z"),
              value: 88,
            },
            {
              recordedAt: Date.parse("2026-03-20T10:02:00Z"),
              value: 92,
            },
          ],
        });

        const rawCount = await t.run(async (ctx) => {
          return (
            await ctx.db
              .query("dataPoints")
              .withIndex("by_source_type_time", (idx) =>
                idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
              )
              .collect()
          ).length;
        });
        expect(rawCount).toBe(0);

        const userPoints = await t.query(api.dataPoints.getTimeSeriesForUser, {
          userId: "user-summary",
          seriesType: "heart_rate",
          startDate: Date.parse("2026-03-20T00:00:00Z"),
          endDate: Date.parse("2026-03-20T23:59:59Z"),
        });
        expect(userPoints).toHaveLength(1);
        expect(userPoints[0]).toMatchObject({
          timestamp: Date.parse("2026-03-20T10:00:00Z"),
          value: 92,
          resolution: "rollup",
          bucketMinutes: 5,
          last: 92,
          count: 2,
        });

        const latest = await t.query(api.dataPoints.getLatestDataPoint, {
          userId: "user-summary",
          seriesType: "heart_rate",
        });
        expect(latest).toMatchObject({
          timestamp: Date.parse("2026-03-20T10:02:00Z"),
          value: 92,
          provider: "garmin",
        });

        const available = await t.query(api.dataPoints.getAvailableSeriesTypes, {
          userId: "user-summary",
        });
        expect(available).toContain("heart_rate");
      } finally {
        vi.useRealTimers();
      }
    });

    it("deletes data older than total retention during maintenance", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-22T12:00:00Z"));

      try {
        const t = convexTest(schema, modules);
        const dsId = await seedDataSource(t, "user-retention", "garmin");

        await t.mutation(internal.dataPoints.storeBatch, {
          dataSourceId: dsId,
          seriesType: "heart_rate",
          points: [
            {
              recordedAt: Date.parse("2026-03-14T10:00:00Z"),
              value: 101,
            },
            {
              recordedAt: Date.parse("2026-03-20T10:00:00Z"),
              value: 105,
            },
          ],
        });

        await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "24h" },
                { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
              ],
            },
          ],
          maintenance: {
            enabled: true,
            interval: "1h",
          },
        });

        await t.mutation(internal.dataPoints.runTimeSeriesMaintenance, {});

        const rawAfter = await t.run(async (ctx) => {
          return await ctx.db
            .query("dataPoints")
            .withIndex("by_source_type_time", (idx) =>
              idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
            )
            .collect();
        });
        expect(rawAfter).toHaveLength(0);

        const rollups = await t.run(async (ctx) => {
          return await ctx.db
            .query("timeSeriesRollups")
            .withIndex("by_source_type_bucket", (idx) =>
              idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
            )
            .collect();
        });
        expect(rollups).toHaveLength(1);
        expect(rollups[0]).toMatchObject({
          bucketMs: 30 * 60 * 1000,
          count: 1,
          avg: 105,
        });
        expect(rollups[0].bucketStart).toBe(Date.parse("2026-03-20T10:00:00Z"));
      } finally {
        vi.useRealTimers();
      }
    });

    it("migrates older rollups into a coarser tier during maintenance", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-22T12:00:00Z"));

      try {
        const t = convexTest(schema, modules);
        const dsId = await seedDataSource(t, "user-migrate", "garmin");

        await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "24h" },
                { kind: "rollup", fromAge: "24h", toAge: null, bucket: "30m" },
              ],
            },
          ],
        });

        await t.mutation(internal.dataPoints.storeBatch, {
          dataSourceId: dsId,
          seriesType: "heart_rate",
          points: [
            {
              recordedAt: Date.parse("2026-03-14T10:00:00Z"),
              value: 90,
            },
            {
              recordedAt: Date.parse("2026-03-14T10:30:00Z"),
              value: 120,
            },
            {
              recordedAt: Date.parse("2026-03-14T11:00:00Z"),
              value: 105,
            },
          ],
        });

        await t.mutation(api.dataPoints.replaceTimeSeriesPolicyConfiguration, {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "24h" },
                { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
                { kind: "rollup", fromAge: "7d", toAge: null, bucket: "3h" },
              ],
            },
          ],
        });

        await t.mutation(internal.dataPoints.runTimeSeriesMaintenance, {});

        const rollups = await t.run(async (ctx) => {
          return await ctx.db
            .query("timeSeriesRollups")
            .withIndex("by_source_type_bucket", (idx) =>
              idx.eq("dataSourceId", dsId).eq("seriesType", "heart_rate"),
            )
            .collect();
        });

        expect(rollups).toHaveLength(1);
        expect(rollups[0]).toMatchObject({
          bucketMs: 3 * 60 * 60 * 1000,
          bucketStart: Date.parse("2026-03-14T09:00:00Z"),
          count: 3,
          avg: 105,
          min: 90,
          max: 120,
          last: 105,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
