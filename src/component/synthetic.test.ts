import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildSyntheticDataPlan } from "./syntheticData";
import { modules } from "./test.setup";

function seedArgs(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    startDate: "2026-07-13",
    endDate: "2026-07-18",
    timezone: "Europe/Madrid",
    seed: "current-week",
    ...overrides,
  };
}

describe("synthetic provider", () => {
  it("stores generated data as a normal synthetic connection and source", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(api.synthetic.seed, seedArgs());

    expect(result).toMatchObject({
      startDate: "2026-07-13",
      endDate: "2026-07-18",
      summariesStored: 18,
    });
    expect(result.eventsStored).toBeGreaterThanOrEqual(6);
    expect(result.dataPointsStored).toBeGreaterThan(100);

    const status = await t.query(api.synthetic.status, { userId: "user-1" });
    expect(status).toMatchObject({
      exists: true,
      startDate: "2026-07-13",
      endDate: "2026-07-18",
      counts: {
        connections: 1,
        dataSources: 1,
        summaries: 18,
        syncJobs: 1,
      },
    });

    const [activitySummaries, sleepEvents, heartRatePoints] = await Promise.all([
      t.query(api.summaries.getDailySummaries, {
        userId: "user-1",
        provider: "synthetic",
        category: "activity",
        startDate: "2026-07-13",
        endDate: "2026-07-18",
      }),
      t.query(api.events.getEvents, {
        userId: "user-1",
        category: "sleep",
      }),
      t.query(api.dataPoints.getTimeSeriesForUser, {
        userId: "user-1",
        seriesType: "heart_rate",
        startDate: Date.parse("2026-07-13T00:00:00.000Z"),
        endDate: Date.parse("2026-07-19T00:00:00.000Z"),
      }),
    ]);
    expect(activitySummaries).toHaveLength(6);
    expect(sleepEvents.events).toHaveLength(6);
    expect(heartRatePoints.length).toBeGreaterThan(50);

    const stored = await t.run(async (ctx) => {
      const connection = await ctx.db.get(result.connectionId as Id<"connections">);
      const source = await ctx.db.get(result.dataSourceId as Id<"dataSources">);
      const summaries = await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_provider_date", (index) =>
          index.eq("userId", "user-1").eq("provider", "synthetic"),
        )
        .collect();
      return { connection, source, summaries };
    });
    expect(stored.connection).toMatchObject({
      provider: "synthetic",
      status: "active",
      providerUserId: "synthetic:user-1",
    });
    expect(stored.source).toMatchObject({
      provider: "synthetic",
      source: "synthetic",
      deviceModel: "SynthDevice",
    });
    expect(stored.summaries.every((summary) => summary.provider === "synthetic")).toBe(true);
  });

  it("coexists with real provider data without collision or takeover logic", async () => {
    const t = convexTest(schema, modules);
    const realConnectionId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "garmin",
        accessToken: "real-token",
        status: "active",
      });
      await ctx.db.insert("dailySummaries", {
        userId: "user-1",
        provider: "garmin",
        date: "2026-07-13",
        category: "activity",
        totalSteps: 9_999,
      });
      return connectionId;
    });

    await t.mutation(api.synthetic.seed, seedArgs());

    const connections = await t.query(api.connections.getConnections, { userId: "user-1" });
    expect(
      connections.map((connection: { provider: string }) => connection.provider).sort(),
    ).toEqual(["garmin", "synthetic"]);
    expect(await t.run(async (ctx) => await ctx.db.get(realConnectionId))).toMatchObject({
      accessToken: "real-token",
    });
  });

  it("requires explicit replacement and atomically leaves one complete integration", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(api.synthetic.seed, seedArgs());

    await expect(t.mutation(api.synthetic.seed, seedArgs())).rejects.toThrow(
      "Pass replaceExisting: true",
    );

    const [second, third] = await Promise.all([
      t.mutation(api.synthetic.seed, seedArgs({ replaceExisting: true, seed: "second" })),
      t.mutation(api.synthetic.seed, seedArgs({ replaceExisting: true, seed: "third" })),
    ]);
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(third.connectionId).not.toBe(first.connectionId);

    const status = await t.query(api.synthetic.status, { userId: "user-1" });
    expect(status.counts).toMatchObject({
      connections: 1,
      dataSources: 1,
      summaries: 18,
      syncJobs: 1,
    });
    expect(status.counts.events).toBeGreaterThan(0);
    expect(status.counts.dataPoints).toBeGreaterThan(0);
  });

  it("validates a replacement plan before changing existing data", async () => {
    const t = convexTest(schema, modules);
    const original = await t.mutation(api.synthetic.seed, seedArgs());

    await expect(
      t.mutation(api.synthetic.seed, seedArgs({ startDate: "invalid", replaceExisting: true })),
    ).rejects.toThrow("Invalid ISO date");

    const status = await t.query(api.synthetic.status, { userId: "user-1" });
    expect(status.connectionId).toBe(original.connectionId);
    expect(status.counts.summaries).toBe(18);
  });

  it("clears only the synthetic provider and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const realConnectionId = await t.run(
      async (ctx) =>
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          accessToken: "real-token",
          status: "active",
        }),
    );
    await t.mutation(api.synthetic.seed, seedArgs());

    const cleared = await t.mutation(api.synthetic.clear, { userId: "user-1" });
    expect(cleared).toMatchObject({
      connections: 1,
      dataSources: 1,
      summaries: 18,
      syncJobs: 1,
    });
    expect(cleared.events).toBeGreaterThan(0);
    expect(cleared.dataPoints).toBeGreaterThan(0);
    expect(
      Object.values(await t.mutation(api.synthetic.clear, { userId: "user-1" })).every(
        (count) => count === 0,
      ),
    ).toBe(true);
    expect(await t.run(async (ctx) => await ctx.db.get(realConnectionId))).toMatchObject({
      accessToken: "real-token",
    });
  });

  it("does not enter provider pull or Garmin backfill workflows", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.mutation(api.synthetic.seed, seedArgs());

    await expect(
      t.mutation(internal.syncWorkflow.requestConnectionSync, {
        connectionId: seeded.connectionId,
        windowStart: Date.now() - 86_400_000,
        windowEnd: Date.now(),
      }),
    ).rejects.toThrow("does not support pull synchronization");
    await expect(
      t.mutation(internal.garminBackfill.requestGarminBackfill, {
        connectionId: seeded.connectionId,
        windowStart: Date.now() - 86_400_000,
        windowEnd: Date.now(),
      }),
    ).rejects.toThrow("only supported for Garmin connections");
  });

  it("isolates generated integrations by user", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.synthetic.seed, seedArgs());
    await t.mutation(api.synthetic.seed, seedArgs({ userId: "user-2" }));

    await t.mutation(api.synthetic.clear, { userId: "user-1" });

    expect(await t.query(api.synthetic.status, { userId: "user-1" })).toMatchObject({
      exists: false,
    });
    expect(await t.query(api.synthetic.status, { userId: "user-2" })).toMatchObject({
      exists: true,
    });
  });

  it("builds deterministic and internally consistent normalized values", () => {
    const base = {
      userId: "user-1",
      startDate: "2026-07-13",
      endDate: "2026-07-18",
      timezone: "Europe/Madrid",
      profile: "mixed" as const,
      seed: "stable",
    };
    const plan = buildSyntheticDataPlan(base);

    expect(plan).toEqual(buildSyntheticDataPlan(base));
    expect(buildSyntheticDataPlan({ ...base, seed: "different" })).not.toEqual(plan);
    expect(plan.points.some((point) => point.seriesType.startsWith("garmin_"))).toBe(false);

    for (const event of plan.events) {
      if (event.category === "workout") {
        expect(event.heartRateAvg).toBeGreaterThanOrEqual(event.heartRateMin ?? 0);
        expect(event.heartRateAvg).toBeLessThanOrEqual(
          event.heartRateMax ?? Number.POSITIVE_INFINITY,
        );
      }
      if (event.category === "sleep") {
        expect(event.sleepStages?.at(-1)?.endTime).toBe(event.endDatetime);
      }
    }
  });

  it("keeps prior calendar days stable when the requested range grows", () => {
    const base = {
      userId: "user-1",
      startDate: "2026-07-13",
      endDate: "2026-07-17",
      timezone: "Europe/Madrid",
      asOf: Date.parse("2026-07-18T12:00:00.000Z"),
      profile: "mixed" as const,
      seed: "stable-range",
    };
    const shorter = buildSyntheticDataPlan(base);
    const longer = buildSyntheticDataPlan({ ...base, endDate: "2026-07-18" });
    const throughJuly17 = <T extends { externalId?: string; recordedAt?: number; date?: string }>(
      values: T[],
    ) =>
      values.filter(
        (value) =>
          value.date !== "2026-07-18" &&
          !value.externalId?.includes(":2026-07-18:") &&
          (value.recordedAt === undefined ||
            value.recordedAt < Date.parse("2026-07-18T00:00:00.000Z")),
      );

    expect(throughJuly17(longer.summaries)).toEqual(shorter.summaries);
    expect(throughJuly17(longer.events)).toEqual(shorter.events);
    expect(throughJuly17(longer.points)).toEqual(shorter.points);
  });

  it("caps current-day events and points at asOf and supports a partial-score profile", () => {
    const asOf = Date.parse("2026-07-18T10:31:00.000Z");
    const plan = buildSyntheticDataPlan({
      userId: "user-1",
      startDate: "2026-07-18",
      endDate: "2026-07-18",
      timezone: "Europe/Madrid",
      asOf,
      profile: "sedentary",
      seed: "partial-score",
    });
    const activity = plan.summaries.find((summary) => summary.category === "activity");
    const sleep = plan.summaries.find((summary) => summary.category === "sleep");

    expect(plan.points.every((point) => point.recordedAt <= asOf)).toBe(true);
    expect(plan.events.every((event) => (event.endDatetime ?? event.startDatetime) <= asOf)).toBe(
      true,
    );
    expect(activity?.totalSteps).toBeLessThan(3_500);
    expect(activity?.activeCalories).toBeLessThan(350);
    expect(sleep?.sleepDurationMinutes).toBeLessThan(420);
  });

  it("builds deterministic showcase weeks with perfect, strong, and low score days", () => {
    const plan = buildSyntheticDataPlan({
      userId: "user-1",
      startDate: "2026-07-06",
      endDate: "2026-07-19",
      timezone: "Europe/Madrid",
      asOf: Date.parse("2026-07-20T12:00:00.000Z"),
      profile: "showcase",
      seed: "good-looking-active-user",
    });

    const scores = plan.dates.map((date) => {
      const activity = plan.summaries.find(
        (summary) => summary.date === date && summary.category === "activity",
      );
      const sleep = plan.summaries.find(
        (summary) => summary.date === date && summary.category === "sleep",
      );
      const factors = [
        (activity?.activeCalories ?? 0) / 350,
        (activity?.totalSteps ?? 0) / 3_500,
        (sleep?.sleepDurationMinutes ?? 0) / 420,
      ].map((value) => Math.min(value, 1));
      return Math.round((factors.reduce((sum, value) => sum + value, 0) / factors.length) * 100);
    });

    for (const week of [scores.slice(0, 7), scores.slice(7, 14)]) {
      expect(week.filter((score) => score === 100)).toHaveLength(4);
      expect(week.filter((score) => score >= 80 && score <= 90)).toHaveLength(2);
      expect(week.filter((score) => score < 70)).toHaveLength(1);
    }
  });

  it("validates timezone, calendar dates, and the 31-day generation limit", () => {
    const base = {
      userId: "user-1",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      timezone: "UTC",
      profile: "mixed" as const,
      seed: "limits",
    };

    expect(buildSyntheticDataPlan(base).dates).toHaveLength(31);
    expect(() => buildSyntheticDataPlan({ ...base, endDate: "2026-02-01" })).toThrow(
      "limited to 31 days",
    );
    expect(() => buildSyntheticDataPlan({ ...base, startDate: "2026-02-30" })).toThrow(
      "Invalid calendar date",
    );
    expect(() => buildSyntheticDataPlan({ ...base, timezone: "Mars/Olympus_Mons" })).toThrow(
      "Invalid timezone",
    );
    expect(() =>
      buildSyntheticDataPlan({
        ...base,
        startDate: "2026-07-18",
        endDate: "2026-07-19",
        asOf: Date.parse("2026-07-18T12:00:00.000Z"),
      }),
    ).toThrow("cannot be after the asOf day");
    expect(() => buildSyntheticDataPlan({ ...base, asOf: Number.NaN })).toThrow(
      "finite non-negative timestamp",
    );
  });

  it("persists the maximum 31-day range in one atomic generation", async () => {
    const t = convexTest(schema, modules);

    const result = await t.mutation(
      api.synthetic.seed,
      seedArgs({ startDate: "2026-01-01", endDate: "2026-01-31", timezone: "UTC" }),
    );

    expect(result.summariesStored).toBe(93);
    expect(result.eventsStored).toBeGreaterThan(31);
    expect(result.dataPointsStored).toBeGreaterThan(500);
    expect(await t.query(api.synthetic.status, { userId: "user-1" })).toMatchObject({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      counts: { connections: 1, dataSources: 1, summaries: 93, syncJobs: 1 },
    });
  });
});
