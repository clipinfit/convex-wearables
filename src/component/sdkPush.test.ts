import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

describe("sdkPush", () => {
  it("stores valid v2 rows and reports malformed rows without rejecting the batch", async () => {
    const t = convexTest(schema, modules);

    const result = await t.action(api.sdkPush.ingestNormalizedPayloadV2, {
      userId: "v2-partial-user",
      provider: "google",
      requestId: "request-partial-1",
      payload: {
        dataPoints: [
          {
            seriesType: "heart_rate",
            recordedAt: Date.parse("2026-08-01T08:00:00Z"),
            value: 62,
            externalId: "v2-valid-point",
          },
          {
            seriesType: "heart_rate",
            recordedAt: "invalid",
            value: 64,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      requestId: "request-partial-1",
      status: "partially_accepted",
      mode: "partial",
      counts: { received: 2, accepted: 1, rejected: 1, stored: 1 },
      categories: {
        dataPoints: { received: 2, accepted: 1, rejected: 1, stored: 1 },
      },
    });
    expect(result.connectionId).toBeTypeOf("string");

    const points = await t.run(async (ctx) => ctx.db.query("dataPoints").collect());
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ externalId: "v2-valid-point", value: 62 });
  });

  it("stores nothing in v2 strict mode when any row is malformed", async () => {
    const t = convexTest(schema, modules);

    const result = await t.action(api.sdkPush.ingestNormalizedPayloadV2, {
      userId: "v2-strict-user",
      provider: "apple",
      requestId: "request-strict-1",
      mode: "strict",
      payload: {
        events: [
          {
            category: "workout",
            startDatetime: Date.parse("2026-08-01T08:00:00Z"),
            externalId: "v2-valid-event",
          },
          {
            category: "workout",
            startDatetime: "invalid",
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: "rejected",
      mode: "strict",
      counts: { received: 2, accepted: 1, rejected: 1, stored: 0 },
    });
    expect(result.connectionId).toBeUndefined();

    const [connections, events] = await t.run(async (ctx) =>
      Promise.all([ctx.db.query("connections").collect(), ctx.db.query("events").collect()]),
    );
    expect(connections).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("keeps accepted v2 writes idempotent across request retries", async () => {
    const t = convexTest(schema, modules);
    const request = {
      userId: "v2-retry-user",
      provider: "samsung" as const,
      requestId: "request-retry-1",
      payload: {
        summaries: [
          {
            date: "2026-08-01",
            category: "activity",
            totalSteps: 8_500,
          },
        ],
      },
    };

    await t.action(api.sdkPush.ingestNormalizedPayloadV2, request);
    await t.action(api.sdkPush.ingestNormalizedPayloadV2, request);

    const summaries = await t.run(async (ctx) => ctx.db.query("dailySummaries").collect());
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      userId: "v2-retry-user",
      provider: "samsung",
      totalSteps: 8_500,
    });
  });

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
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "google",
          source: "health-connect",
          category: "activity",
        }),
        expect.objectContaining({
          provider: "google",
          source: "health-connect",
          category: "recovery",
        }),
      ]),
    );
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
        appId: "com.thirdparty.writer",
      },
      events: [
        {
          category: "workout",
          type: "CYCLING_STATIONARY",
          startDatetime: Date.parse("2026-03-18T08:00:00Z"),
          endDatetime: Date.parse("2026-03-18T08:45:00Z"),
          externalId: "hc-cycling-1",
        },
      ],
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
        {
          seriesType: "POWER",
          recordedAt: Date.parse("2026-03-18T12:03:00Z"),
          value: 220,
          externalId: "hc-power-1",
        },
        {
          seriesType: "SPEED",
          recordedAt: Date.parse("2026-03-18T12:04:00Z"),
          value: 7.5,
          externalId: "hc-speed-1",
        },
        {
          seriesType: "CYCLING_PEDALING_CADENCE",
          recordedAt: Date.parse("2026-03-18T12:05:00Z"),
          value: 88,
          externalId: "hc-cadence-1",
        },
        {
          seriesType: "TOTAL_CALORIES_BURNED",
          recordedAt: Date.parse("2026-03-18T12:06:00Z"),
          value: 830,
          externalId: "hc-total-calories-1",
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
      originalSourceName: "com.thirdparty.writer",
    });

    const events = await t.run(async (ctx) => {
      return await ctx.db
        .query("events")
        .withIndex("by_user_category_time", (idx) =>
          idx.eq("userId", "user-3").eq("category", "workout"),
        )
        .collect();
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "indoor_cycling",
      externalId: "hc-cycling-1",
    });

    const points = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", source!._id))
        .collect();
    });

    expect(points.map((point) => point.seriesType).sort()).toEqual([
      "active_calories",
      "cadence",
      "distance",
      "floors_climbed",
      "heart_rate_variability_rmssd",
      "power",
      "speed",
      "total_calories",
    ]);

    const summaries = await t.run(async (ctx) => {
      return await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_date", (idx) => idx.eq("userId", "user-3").eq("date", "2026-03-18"))
        .collect();
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      provider: "google",
      source: "health-connect",
      category: "activity",
      totalSteps: 12345,
      totalCalories: 780,
    });
  });

  it("keeps Apple and Google daily summaries separate for the same user date and category", async () => {
    const t = convexTest(schema, modules);

    await t.action(api.sdkPush.ingestNormalizedPayload, {
      userId: "user-mixed",
      provider: "apple",
      sourceMetadata: {
        source: "healthkit",
        originalSourceName: "Apple Watch",
      },
      summaries: [
        {
          date: "2026-03-18",
          category: "activity",
          totalSteps: 9000,
          activeCalories: 450,
        },
      ],
    });

    await t.action(api.sdkPush.ingestNormalizedPayload, {
      userId: "user-mixed",
      provider: "google",
      sourceMetadata: {
        source: "health-connect",
        originalSourceName: "com.google.android.apps.fitness",
      },
      summaries: [
        {
          date: "2026-03-18",
          category: "activity",
          totalSteps: 7200,
          activeCalories: 330,
        },
      ],
    });

    const summaries = await t.run(async (ctx) => {
      return await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_category_date", (idx) =>
          idx.eq("userId", "user-mixed").eq("category", "activity").eq("date", "2026-03-18"),
        )
        .collect();
    });

    expect(summaries).toHaveLength(2);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "apple",
          source: "healthkit",
          originalSourceName: "Apple Watch",
          totalSteps: 9000,
          activeCalories: 450,
        }),
        expect.objectContaining({
          provider: "google",
          source: "health-connect",
          originalSourceName: "com.google.android.apps.fitness",
          totalSteps: 7200,
          activeCalories: 330,
        }),
      ]),
    );
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
