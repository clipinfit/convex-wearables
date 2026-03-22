import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { GARMIN_BACKFILL_TYPES } from "./garminBackfill";
import { triggerBackfill } from "./providers/garmin";
import schema from "./schema";
import { modules } from "./test.setup";

function createTest() {
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("garminWebhooks", () => {
  it("ingests Garmin wellness feeds into events, data points, and summaries", async () => {
    const t = createTest();

    await t.run(async (ctx) => {
      await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "garmin",
        providerUserId: "garmin-user-1",
        accessToken: "garmin-token",
        scope: "OLD_SCOPE",
        status: "active",
      });
    });

    const dayStart = Math.floor(Date.parse("2026-03-16T00:00:00Z") / 1000);
    const midday = Math.floor(Date.parse("2026-03-16T12:00:00Z") / 1000);

    await t.action(api.garminWebhooks.processPushPayload, {
      garminClientId: "garmin-client",
      payload: {
        activities: [
          {
            userId: "garmin-user-1",
            activityId: 101,
            activityType: "RUNNING",
            startTimeInSeconds: dayStart + 3600,
            durationInSeconds: 1800,
            deviceName: "Forerunner 965",
            averageHeartRateInBeatsPerMinute: 145,
            maxHeartRateInBeatsPerMinute: 176,
            distanceInMeters: 5000,
          },
        ],
        activityDetails: [
          {
            userId: "garmin-user-1",
            activityId: 202,
            summaryId: "202-detail",
            summary: {
              activityType: "CYCLING",
              startTimeInSeconds: dayStart + 7200,
              durationInSeconds: 2700,
              deviceName: "Edge 1040",
              averageHeartRateInBeatsPerMinute: 138,
              maxHeartRateInBeatsPerMinute: 170,
              distanceInMeters: 18000,
            },
          },
        ],
        sleeps: [
          {
            userId: "garmin-user-1",
            summaryId: "sleep-1",
            startTimeInSeconds: dayStart,
            durationInSeconds: 8 * 60 * 60,
            deepSleepDurationInSeconds: 90 * 60,
            lightSleepDurationInSeconds: 240 * 60,
            remSleepInSeconds: 90 * 60,
            awakeDurationInSeconds: 60 * 60,
            averageHeartRate: 52,
            lowestHeartRate: 45,
            avgOxygenSaturation: 95,
            respirationAvg: 14,
            overallSleepScore: { value: 88 },
          },
        ],
        dailies: [
          {
            userId: "garmin-user-1",
            summaryId: "daily-1",
            startTimeInSeconds: dayStart,
            durationInSeconds: 24 * 60 * 60,
            calendarDate: "2026-03-16",
            steps: 12345,
            distanceInMeters: 9600,
            activeKilocalories: 640,
            bmrKilocalories: 1550,
            floorsClimbed: 12,
            minHeartRateInBeatsPerMinute: 46,
            maxHeartRateInBeatsPerMinute: 176,
            averageHeartRateInBeatsPerMinute: 72,
            restingHeartRateInBeatsPerMinute: 48,
            averageStressLevel: 30,
            bodyBatteryChargedValue: 80,
            bodyBatteryDrainedValue: 35,
            moderateIntensityDurationInSeconds: 1800,
            vigorousIntensityDurationInSeconds: 900,
            timeOffsetHeartRateSamples: {
              "0": 50,
              "300": 58,
            },
          },
        ],
        epochs: [
          {
            userId: "garmin-user-1",
            summaryId: "epoch-1",
            startTimeInSeconds: dayStart + 900,
            durationInSeconds: 900,
            steps: 120,
            activeKilocalories: 10,
            meanHeartRateInBeatsPerMinute: 92,
          },
        ],
        bodyComps: [
          {
            userId: "garmin-user-1",
            summaryId: "body-1",
            measurementTimeInSeconds: midday,
            weightInGrams: 70000,
            bodyFatInPercent: 18.5,
            bodyMassIndex: 22.5,
            muscleMassInGrams: 32000,
          },
        ],
        hrv: [
          {
            userId: "garmin-user-1",
            summaryId: "hrv-1",
            startTimeInSeconds: dayStart,
            calendarDate: "2026-03-16",
            lastNightAvg: 55,
            hrvValues: {
              "0": 50,
              "300": 60,
            },
          },
        ],
        stressDetails: [
          {
            userId: "garmin-user-1",
            summaryId: "stress-1",
            startTimeInSeconds: midday,
            stressLevelValues: {
              "0": 20,
              "180": 25,
            },
            bodyBatteryValues: {
              "0": 75,
            },
          },
        ],
        respiration: [
          {
            userId: "garmin-user-1",
            summaryId: "resp-1",
            startTimeInSeconds: midday,
            avgWakingRespirationValue: 14.5,
            timeOffsetRespirationRateValues: {
              "0": 14.5,
              "300": 15.1,
            },
          },
        ],
        pulseOx: [
          {
            userId: "garmin-user-1",
            summaryId: "spo2-1",
            startTimeInSeconds: midday,
            calendarDate: "2026-03-16",
            avgSpo2: 97,
            timeOffsetSpo2Values: {
              "0": 97,
              "300": 96,
            },
          },
        ],
        bloodPressures: [
          {
            userId: "garmin-user-1",
            summaryId: "bp-1",
            measurementTimestampGMT: midday,
            systolic: 120,
            diastolic: 80,
          },
        ],
        userMetrics: [
          {
            userId: "garmin-user-1",
            summaryId: "metrics-1",
            calendarDate: "2026-03-16",
            vo2Max: 52,
            fitnessAge: 30,
          },
        ],
        skinTemp: [
          {
            userId: "garmin-user-1",
            summaryId: "skin-1",
            startTimeInSeconds: midday,
            skinTemperature: 33.2,
          },
        ],
        healthSnapshot: [
          {
            userId: "garmin-user-1",
            summaryId: "snapshot-1",
            startTimeInSeconds: midday + 60,
            heartRate: 54,
            hrv: 58,
            stress: 12,
            spo2: 98,
            respiration: 13.8,
          },
        ],
        moveiq: [
          {
            userId: "garmin-user-1",
            summaryId: "moveiq-1",
            startTimeInSeconds: dayStart + 10_800,
            durationInSeconds: 600,
            activityType: "WALKING",
          },
        ],
        mct: [
          {
            userId: "garmin-user-1",
            summaryId: "mct-1",
            periodStartDateStr: "2026-03-14",
            dayInCycle: 3,
            cycleLength: 28,
          },
        ],
        userPermissionsChange: [
          {
            userId: "garmin-user-1",
            permissions: ["HEALTH_EXPORT", "ACTIVITY_EXPORT"],
          },
        ],
      },
    });

    const result = await t.run(async (ctx) => {
      const events = await ctx.db.query("events").collect();
      const summaries = await ctx.db.query("dailySummaries").collect();
      const dataPoints = await ctx.db.query("dataPoints").collect();
      const menstrualCycles = await ctx.db.query("menstrualCycles").collect();
      const connection = await ctx.db
        .query("connections")
        .withIndex("by_provider_user", (idx) =>
          idx.eq("provider", "garmin").eq("providerUserId", "garmin-user-1"),
        )
        .first();

      return {
        connection,
        events,
        summaries,
        dataPointTypes: Array.from(new Set(dataPoints.map((point) => point.seriesType))).sort(),
        menstrualCycles,
      };
    });

    expect(result.connection?.scope).toBe("ACTIVITY_EXPORT HEALTH_EXPORT");
    expect(result.events).toHaveLength(4);
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["running", "cycling", "sleep_session", "moveiq_walking"]),
    );

    const activitySummary = result.summaries.find(
      (summary) => summary.category === "activity" && summary.date === "2026-03-16",
    );
    const recoverySummary = result.summaries.find(
      (summary) => summary.category === "recovery" && summary.date === "2026-03-16",
    );
    const bodySummary = result.summaries.find(
      (summary) => summary.category === "body" && summary.date === "2026-03-16",
    );
    const sleepSummary = result.summaries.find(
      (summary) => summary.category === "sleep" && summary.date === "2026-03-16",
    );

    expect(activitySummary).toMatchObject({
      totalSteps: 12345,
      totalCalories: 2190,
      activeCalories: 640,
      totalDistance: 9600,
      floorsClimbed: 12,
      avgHeartRate: 72,
      maxHeartRate: 176,
      minHeartRate: 46,
      activeMinutes: 45,
    });
    expect(recoverySummary).toMatchObject({
      restingHeartRate: 48,
      avgStressLevel: 30,
      bodyBattery: 45,
      hrvAvg: 55,
      spo2Avg: 97,
    });
    expect(bodySummary).toMatchObject({
      weight: 70,
      bodyFatPercentage: 18.5,
      bodyMassIndex: 22.5,
    });
    expect(sleepSummary).toMatchObject({
      sleepDurationMinutes: 480,
      sleepEfficiency: 88,
      deepSleepMinutes: 90,
      lightSleepMinutes: 240,
      remSleepMinutes: 90,
      awakeDuringMinutes: 60,
    });

    expect(result.dataPointTypes).toEqual(
      expect.arrayContaining([
        "blood_pressure_diastolic",
        "blood_pressure_systolic",
        "body_fat_percentage",
        "body_mass_index",
        "energy",
        "garmin_body_battery",
        "garmin_fitness_age",
        "garmin_stress_level",
        "heart_rate",
        "heart_rate_variability_sdnn",
        "oxygen_saturation",
        "respiratory_rate",
        "resting_heart_rate",
        "skeletal_muscle_mass",
        "skin_temperature",
        "steps",
        "vo2_max",
        "weight",
      ]),
    );
    expect(result.menstrualCycles).toHaveLength(1);
  });

  it("keeps existing activity timestamps intact when Garmin sends nested activityDetails", async () => {
    const t = createTest();

    await t.run(async (ctx) => {
      await ctx.db.insert("connections", {
        userId: "user-activity-details",
        provider: "garmin",
        providerUserId: "garmin-user-activity-details",
        accessToken: "garmin-token",
        status: "active",
      });
    });

    const startTimeInSeconds = Math.floor(Date.parse("2026-03-20T09:00:00Z") / 1000);
    const durationInSeconds = 3421;

    await t.action(api.garminWebhooks.processPushPayload, {
      garminClientId: "garmin-client",
      payload: {
        activities: [
          {
            userId: "garmin-user-activity-details",
            activityId: 22258974253,
            activityType: "RUNNING",
            startTimeInSeconds,
            durationInSeconds,
            averageHeartRateInBeatsPerMinute: 156,
            maxHeartRateInBeatsPerMinute: 173,
            activeKilocalories: 753,
            distanceInMeters: 10016.89,
            steps: 9290,
            averageSpeedInMetersPerSecond: 2.928,
            maxSpeedInMetersPerSecond: 3.835,
            totalElevationGainInMeters: 52.2,
          },
        ],
      },
    });

    await t.action(api.garminWebhooks.processPushPayload, {
      garminClientId: "garmin-client",
      payload: {
        activityDetails: [
          {
            userId: "garmin-user-activity-details",
            activityId: 22258974253,
            summaryId: "22258974253-detail",
            summary: {
              activityType: "RUNNING",
              startTimeInSeconds,
              durationInSeconds,
              averageHeartRateInBeatsPerMinute: 156,
              maxHeartRateInBeatsPerMinute: 173,
              activeKilocalories: 753,
              distanceInMeters: 10016.89,
              steps: 9290,
              averageSpeedInMetersPerSecond: 2.928,
              maxSpeedInMetersPerSecond: 3.835,
              totalElevationGainInMeters: 52.2,
            },
          },
        ],
      },
    });

    const events = await t.run(async (ctx) => {
      return await ctx.db.query("events").collect();
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalId: "garmin-22258974253",
      type: "running",
      sourceName: "Garmin",
      durationSeconds: durationInSeconds,
      startDatetime: startTimeInSeconds * 1000,
      endDatetime: (startTimeInSeconds + durationInSeconds) * 1000,
      energyBurned: 753,
      distance: 10016.89,
      averageSpeed: 2.928,
      maxSpeed: 3.835,
      totalElevationGain: 52.2,
    });
    expect(Number.isNaN(events[0]?.startDatetime)).toBe(false);
    expect(Number.isNaN(events[0]?.endDatetime)).toBe(false);
  });

  it("skips Garmin activities whose timing cannot be parsed", async () => {
    const t = createTest();

    await t.run(async (ctx) => {
      await ctx.db.insert("connections", {
        userId: "user-invalid-activity",
        provider: "garmin",
        providerUserId: "garmin-user-invalid-activity",
        accessToken: "garmin-token",
        status: "active",
      });
    });

    await t.action(api.garminWebhooks.processPushPayload, {
      garminClientId: "garmin-client",
      payload: {
        activities: [
          {
            userId: "garmin-user-invalid-activity",
            activityId: 303,
            activityType: "RUNNING",
            startTimeInSeconds: "not-a-timestamp",
            durationInSeconds: 1800,
          },
        ],
      },
    });

    const events = await t.run(async (ctx) => {
      return await ctx.db.query("events").collect();
    });

    expect(events).toHaveLength(0);
  });

  it("updates Garmin scopes and revokes connections on deregistration", async () => {
    const t = createTest();

    await t.run(async (ctx) => {
      await ctx.db.insert("connections", {
        userId: "user-2",
        provider: "garmin",
        providerUserId: "garmin-user-2",
        accessToken: "garmin-token",
        scope: "OLD_SCOPE",
        status: "active",
      });
    });

    await t.action(api.garminWebhooks.processPushPayload, {
      garminClientId: "garmin-client",
      payload: {
        userPermissionsChange: [
          {
            userId: "garmin-user-2",
            permissions: ["HEALTH_EXPORT"],
          },
        ],
        deregistrations: [
          {
            userId: "garmin-user-2",
          },
        ],
      },
    });

    const connection = await t.run(async (ctx) => {
      return await ctx.db
        .query("connections")
        .withIndex("by_provider_user", (idx) =>
          idx.eq("provider", "garmin").eq("providerUserId", "garmin-user-2"),
        )
        .first();
    });

    expect(connection?.scope).toBe("HEALTH_EXPORT");
    expect(connection?.status).toBe("revoked");
  });

  it("accepts stringified daily payloads with oversized heart-rate sample maps", async () => {
    const t = createTest();

    await t.run(async (ctx) => {
      await ctx.db.insert("connections", {
        userId: "user-3",
        provider: "garmin",
        providerUserId: "garmin-user-3",
        accessToken: "garmin-token",
        status: "active",
      });
    });

    const dayStart = Math.floor(Date.parse("2026-03-17T00:00:00Z") / 1000);
    const timeOffsetHeartRateSamples = Object.fromEntries(
      Array.from({ length: 1100 }, (_, index) => [String(index * 15), 60 + (index % 40)]),
    );

    await t.action(api.garminWebhooks.processPushPayload, {
      garminClientId: "garmin-client",
      payloadJson: JSON.stringify({
        dailies: [
          {
            userId: "garmin-user-3",
            summaryId: "daily-large-1",
            startTimeInSeconds: dayStart,
            durationInSeconds: 24 * 60 * 60,
            calendarDate: "2026-03-17",
            restingHeartRateInBeatsPerMinute: 47,
            timeOffsetHeartRateSamples,
          },
        ],
      }),
    });

    const result = await t.run(async (ctx) => {
      const dataPoints = await ctx.db.query("dataPoints").collect();
      const summaries = await ctx.db.query("dailySummaries").collect();
      return { dataPoints, summaries };
    });

    expect(result.dataPoints.filter((point) => point.seriesType === "heart_rate")).toHaveLength(
      1100,
    );
    expect(
      result.dataPoints.filter((point) => point.seriesType === "resting_heart_rate"),
    ).toHaveLength(1);
    expect(
      result.summaries.find(
        (summary) => summary.category === "recovery" && summary.date === "2026-03-17",
      ),
    ).toMatchObject({
      restingHeartRate: 47,
    });
  });
});

describe("garminBackfill", () => {
  it("includes the extended Garmin data types in the backfill workflow", () => {
    expect(GARMIN_BACKFILL_TYPES).toEqual(
      expect.arrayContaining([
        "activityDetails",
        "epochs",
        "bodyComps",
        "hrv",
        "stressDetails",
        "respiration",
        "pulseOx",
        "bloodPressures",
        "userMetrics",
        "skinTemp",
        "healthSnapshot",
        "moveiq",
        "mct",
      ]),
    );
  });

  it("triggers extended Garmin backfill endpoints even when Garmin returns an empty 202 body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(
      triggerBackfill("garmin-token", "healthSnapshot", 100, 200),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://apis.garmin.com/wellness-api/rest/backfill/healthSnapshot?summaryStartTimeInSeconds=100&summaryEndTimeInSeconds=200",
    );
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer garmin-token",
      Accept: "application/json",
    });
  });
});
