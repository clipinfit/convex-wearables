import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

describe("workout enrichment", () => {
  it("replaces enrichment idempotently and returns provider-neutral detail", async () => {
    const t = convexTest(schema, modules);
    const { eventId } = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "garmin",
        status: "active",
      });
      const dataSourceId = await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        connectionId,
      });
      const eventId = await ctx.db.insert("events", {
        dataSourceId,
        userId: "user-1",
        category: "workout",
        startDatetime: 1_000,
      });
      return { eventId };
    });

    const input = {
      eventId,
      userId: "user-1",
      provider: "garmin" as const,
      segments: [{ kind: "lap" as const, index: 0, distanceMeters: 1_000 }],
      zones: [{ kind: "heart_rate" as const, zone: 1, seconds: 120, upperBound: 140 }],
    };
    await t.mutation(internal.workoutEnrichment.replaceWorkoutEnrichment, input);
    await t.mutation(internal.workoutEnrichment.replaceWorkoutEnrichment, input);

    const result = await t.query(api.workoutEnrichment.getWorkoutEnrichment, { eventId });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ kind: "lap", distanceMeters: 1_000 });
    expect(result.zones).toHaveLength(1);
    expect(result.zones[0]).toMatchObject({ kind: "heart_rate", seconds: 120 });
  });

  it("cascades detail when deleting a workout by external id", async () => {
    const t = convexTest(schema, modules);
    const eventId = await t.run(async (ctx) => {
      const dataSourceId = await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
      });
      const eventId = await ctx.db.insert("events", {
        dataSourceId,
        userId: "user-1",
        category: "workout",
        startDatetime: 1_000,
        externalId: "garmin-42",
      });
      await ctx.db.insert("workoutSegments", {
        eventId,
        userId: "user-1",
        provider: "garmin",
        kind: "set",
        index: 0,
        schemaVersion: 1,
      });
      return eventId;
    });

    await t.mutation(internal.events.deleteByExternalId, { externalId: "garmin-42" });
    expect(await t.run((ctx) => ctx.db.get(eventId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("workoutSegments").collect())).toEqual([]);
  });
});
