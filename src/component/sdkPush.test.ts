import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

describe("sdkPush", () => {
  it("ingests normalized Google Health Connect data into connections, sources, events, points, and summaries", async () => {
    const t = convexTest(schema, modules);

    const result = await t.action(api.sdkPush.ingestNormalizedPayload, {
      userId: "user-1",
      provider: "google",
      providerUserId: "hc-user-1",
      providerUsername: "denis@example.com",
      sourceMetadata: {
        deviceModel: "Pixel Watch 3",
        source: "health-connect",
      },
      events: [
        {
          category: "sleep",
          type: "sleep_session",
          startDatetime: Date.parse("2026-03-17T22:30:00Z"),
          endDatetime: Date.parse("2026-03-18T06:30:00Z"),
          durationSeconds: 8 * 60 * 60,
          externalId: "hc-sleep-1",
          sleepTotalDurationMinutes: 440,
          sleepTimeInBedMinutes: 480,
          sleepDeepMinutes: 90,
          sleepLightMinutes: 240,
          sleepRemMinutes: 110,
          sleepAwakeMinutes: 40,
          sleepEfficiencyScore: 91,
        },
      ],
      dataPoints: [
        {
          seriesType: "heart_rate",
          recordedAt: Date.parse("2026-03-18T07:00:00Z"),
          value: 58,
          externalId: "hc-hr-1",
        },
        {
          seriesType: "steps",
          recordedAt: Date.parse("2026-03-18T12:00:00Z"),
          value: 4200,
          externalId: "hc-steps-1",
        },
        {
          seriesType: "resting_heart_rate",
          recordedAt: Date.parse("2026-03-18T07:00:00Z"),
          value: 49,
          externalId: "hc-rhr-1",
        },
      ],
      summaries: [
        {
          date: "2026-03-18",
          category: "activity",
          totalSteps: 10000,
          totalCalories: 650,
        },
        {
          date: "2026-03-18",
          category: "recovery",
          restingHeartRate: 49,
        },
      ],
    });

    expect(result.eventsStored).toBe(1);
    expect(result.dataPointsStored).toBe(3);
    expect(result.summariesStored).toBe(2);

    const connection = await t.run(async (ctx) => {
      return await ctx.db
        .query("connections")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1").eq("provider", "google"))
        .first();
    });
    expect(connection).toMatchObject({
      userId: "user-1",
      provider: "google",
      providerUserId: "hc-user-1",
      providerUsername: "denis@example.com",
      status: "active",
    });
    expect(connection?.lastSyncedAt).toBeTypeOf("number");

    const dataSources = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1").eq("provider", "google"))
        .collect();
    });
    expect(dataSources).toHaveLength(1);
    expect(dataSources[0]).toMatchObject({
      deviceModel: "Pixel Watch 3",
      source: "health-connect",
    });

    const events = await t.run(async (ctx) => {
      return await ctx.db
        .query("events")
        .withIndex("by_user_category_time", (idx) =>
          idx.eq("userId", "user-1").eq("category", "sleep"),
        )
        .collect();
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "hc-sleep-1",
      sleepTotalDurationMinutes: 440,
      sourceName: "Google Health Connect",
    });

    const dataPoints = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", dataSources[0]._id))
        .collect();
    });
    expect(dataPoints).toHaveLength(3);

    const summaries = await t.run(async (ctx) => {
      return await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_date", (idx) => idx.eq("userId", "user-1").eq("date", "2026-03-18"))
        .collect();
    });
    expect(summaries).toHaveLength(2);
  });

  it("deduplicates SDK pushes by external id and source-time keys", async () => {
    const t = convexTest(schema, modules);

    await t.action(api.sdkPush.ingestNormalizedPayload, {
      userId: "user-2",
      provider: "apple",
      sourceMetadata: {
        deviceModel: "Apple Watch Ultra 2",
        source: "healthkit",
      },
      events: [
        {
          category: "workout",
          type: "running",
          startDatetime: Date.parse("2026-03-18T10:00:00Z"),
          endDatetime: Date.parse("2026-03-18T10:30:00Z"),
          externalId: "apple-workout-1",
          distance: 5000,
        },
      ],
      dataPoints: [
        {
          seriesType: "heart_rate",
          recordedAt: Date.parse("2026-03-18T10:15:00Z"),
          value: 148,
        },
      ],
    });

    await t.action(api.sdkPush.ingestNormalizedPayload, {
      userId: "user-2",
      provider: "apple",
      sourceMetadata: {
        deviceModel: "Apple Watch Ultra 2",
        source: "healthkit",
      },
      events: [
        {
          category: "workout",
          type: "running",
          startDatetime: Date.parse("2026-03-18T10:00:00Z"),
          endDatetime: Date.parse("2026-03-18T10:30:00Z"),
          externalId: "apple-workout-1",
          distance: 5200,
        },
      ],
      dataPoints: [
        {
          seriesType: "heart_rate",
          recordedAt: Date.parse("2026-03-18T10:15:00Z"),
          value: 150,
        },
      ],
    });

    const sources = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-2").eq("provider", "apple"))
        .collect();
    });

    const events = await t.run(async (ctx) => {
      return await ctx.db
        .query("events")
        .withIndex("by_user_category_time", (idx) =>
          idx.eq("userId", "user-2").eq("category", "workout"),
        )
        .collect();
    });
    expect(events).toHaveLength(1);
    expect(events[0].distance).toBe(5200);

    const dataPoints = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) =>
          idx
            .eq("dataSourceId", sources[0]._id)
            .eq("seriesType", "heart_rate")
            .eq("recordedAt", Date.parse("2026-03-18T10:15:00Z")),
        )
        .collect();
    });
    expect(dataPoints).toHaveLength(1);
    expect(dataPoints[0].value).toBe(150);
  });

  it("accepts plan-compatible payload aliases and normalizes series types", async () => {
    const t = convexTest(schema, modules);

    await t.action(api.sdkPush.ingestNormalizedPayload, {
      userId: "user-3",
      provider: "google",
      syncTimestamp: Date.parse("2026-03-18T18:00:00Z"),
      device: {
        model: "Pixel 9 Pro",
        softwareVersion: "Android 16",
        source: "health-connect",
      },
      dataPoints: [
        {
          seriesType: "hrv_rmssd",
          recordedAt: Date.parse("2026-03-18T07:00:00Z"),
          value: 42,
          externalId: "hc-hrv-1",
        },
        {
          seriesType: "floors_climbed",
          recordedAt: Date.parse("2026-03-18T12:00:00Z"),
          value: 12,
          externalId: "hc-floors-1",
        },
        {
          seriesType: "distance",
          recordedAt: Date.parse("2026-03-18T12:01:00Z"),
          value: 1500,
          externalId: "hc-distance-1",
        },
        {
          seriesType: "active_calories",
          recordedAt: Date.parse("2026-03-18T12:02:00Z"),
          value: 340,
          externalId: "hc-active-calories-1",
        },
      ],
      dailySummaries: [
        {
          date: "2026-03-18",
          category: "activity",
          totalSteps: 12345,
          totalCalories: 780,
        },
      ],
    });

    const source = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-3").eq("provider", "google"))
        .first();
    });

    expect(source).toMatchObject({
      deviceModel: "Pixel 9 Pro",
      softwareVersion: "Android 16",
      source: "health-connect",
    });

    const points = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", source!._id))
        .collect();
    });

    expect(points.map((point) => point.seriesType).sort()).toEqual([
      "active_calories",
      "distance",
      "floors_climbed",
      "heart_rate_variability_rmssd",
    ]);

    const summaries = await t.run(async (ctx) => {
      return await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_date", (idx) => idx.eq("userId", "user-3").eq("date", "2026-03-18"))
        .collect();
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      category: "activity",
      totalSteps: 12345,
      totalCalories: 780,
    });
  });

  it("batches large data-point payloads across multiple writes", async () => {
    const t = convexTest(schema, modules);

    await t.action(api.sdkPush.ingestNormalizedPayload, {
      userId: "user-4",
      provider: "google",
      sourceMetadata: {
        deviceModel: "Pixel Watch 3",
        source: "health-connect",
      },
      dataPoints: Array.from({ length: 205 }, (_, index) => ({
        seriesType: "heart_rate",
        recordedAt: Date.parse("2026-03-18T10:00:00Z") + index * 60_000,
        value: 120 + (index % 5),
        externalId: `hc-batch-${index}`,
      })),
    });

    const source = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-4").eq("provider", "google"))
        .first();
    });

    const points = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) =>
          idx.eq("dataSourceId", source!._id).eq("seriesType", "heart_rate"),
        )
        .collect();
    });

    expect(points).toHaveLength(205);
  });

  it("rejects unsupported series types", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.action(api.sdkPush.ingestNormalizedPayload, {
        userId: "user-5",
        provider: "google",
        dataPoints: [
          {
            seriesType: "totally_unknown_metric",
            recordedAt: Date.parse("2026-03-18T10:00:00Z"),
            value: 1,
          },
        ],
      }),
    ).rejects.toThrow('Unsupported series type "totally_unknown_metric"');
  });
});
