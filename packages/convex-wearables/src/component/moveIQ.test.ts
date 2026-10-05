import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { normalizeMoveIQ } from "./providers/garmin";
import schema from "./schema";
import { modules } from "./test.setup";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("outgoingWebhookWorkflow", workflowTest.schema, workflowTest.modules);
  workpoolTest.register(t, "outgoingWebhookWorkflow/workpool");
  const dataSourceId = await t.run((ctx) =>
    ctx.db.insert("dataSources", {
      userId: "user-1",
      provider: "garmin",
    }),
  );
  return { t, dataSourceId };
}

const moveIQ = normalizeMoveIQ({
  userId: "garmin-1",
  summaryId: "iq-1",
  activityType: "RUNNING",
  startTimeInSeconds: 1_790_496_240,
  durationInSeconds: 3420,
});

describe("Move IQ classification", () => {
  it("keeps recorded workouts separate even with identical time intervals and repeated ingestion", async () => {
    const { t, dataSourceId } = await setup();
    const event = { ...moveIQ, dataSourceId, userId: "user-1" };
    const activityId = await t.mutation(internal.events.storeEvent, event);
    const workoutId = await t.mutation(internal.events.storeEvent, {
      ...event,
      category: "workout",
      type: "running",
      externalId: "garmin-recorded-1",
      distance: 10061.72,
      energyBurned: 699,
    });
    expect(workoutId).not.toBe(activityId);
    expect(await t.mutation(internal.events.storeEvent, event)).toBe(activityId);
    const workouts = await t.query(api.events.getEvents, {
      userId: "user-1",
      category: "workout",
      limit: 1,
    });
    expect(workouts.events.map((row: Doc<"events">) => row._id)).toEqual([workoutId]);
    const activities = await t.query(api.events.getEventsWithSources, {
      userId: "user-1",
      category: "activity",
    });
    expect(activities.events.map((row: Doc<"events">) => row._id)).toEqual([activityId]);
  });

  it("uses activity webhooks for single writes, batch writes, and deletion", async () => {
    const { t, dataSourceId } = await setup();
    await t.mutation(api.outgoingWebhooks.configureOutgoingWebhooks, {
      captureEnabled: true,
      externalDeliveryEnabled: false,
    });
    await t.mutation(api.outgoingWebhooks.setWebhookUserTenant, {
      userId: "user-1",
      tenantId: "tenant-1",
    });
    await t.mutation(internal.events.storeEvent, { ...moveIQ, dataSourceId, userId: "user-1" });
    await t.mutation(internal.events.storeEventBatch, {
      events: [
        {
          ...moveIQ,
          dataSourceId,
          userId: "user-1",
          externalId: "garmin-moveiq-iq-2",
          startDatetime: moveIQ.startDatetime + 1000,
        },
      ],
    });
    await t.mutation(internal.events.deleteByExternalId, {
      externalId: "garmin-moveiq-iq-1",
      userId: "user-1",
    });
    const events = await t.run((ctx) => ctx.db.query("outgoingWebhookEvents").collect());
    expect(events.map((row) => row.eventType)).toEqual([
      "activity.upserted",
      "activity.upserted",
      "activity.deleted",
    ]);
    expect(events.every((row) => row.subjectKind === "activity")).toBe(true);
  });

  it("dry-runs and resumes migration without losing data or touching other providers", async () => {
    const { t, dataSourceId } = await setup();
    const otherSourceId = await t.run((ctx) =>
      ctx.db.insert("dataSources", { userId: "user-1", provider: "strava" }),
    );
    const before = await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        ...moveIQ,
        dataSourceId,
        userId: "user-1",
        category: "workout",
      });
      await ctx.db.insert("events", {
        ...moveIQ,
        dataSourceId,
        userId: "user-1",
        category: "workout",
        type: "moveiq",
        externalId: "garmin-moveiq-unknown",
      });
      await ctx.db.insert("events", {
        ...moveIQ,
        dataSourceId: otherSourceId,
        userId: "user-1",
        category: "workout",
      });
      await ctx.db.insert("events", {
        ...moveIQ,
        dataSourceId,
        userId: "user-1",
        category: "workout",
        type: "running",
        externalId: "garmin-recorded",
      });
      return await ctx.db.query("events").collect();
    });
    expect(await t.mutation(api.events.migrateGarminMoveIQ, {})).toMatchObject({
      scanned: 4,
      eligible: 2,
      migrated: 0,
      isDone: true,
    });
    expect(await t.run((ctx) => ctx.db.query("events").collect())).toEqual(before);
    let cursor: string | undefined;
    let migrated = 0;
    do {
      const page = await t.mutation(api.events.migrateGarminMoveIQ, {
        cursor,
        limit: 1,
        dryRun: false,
      });
      migrated += page.migrated;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(migrated).toBe(2);
    const after = await t.run((ctx) => ctx.db.query("events").collect());
    expect(after).toEqual(
      before.map((row, index) => (index < 2 ? { ...row, category: "activity" } : row)),
    );
    expect(await t.mutation(api.events.migrateGarminMoveIQ, { dryRun: false })).toMatchObject({
      eligible: 0,
      migrated: 0,
    });
  });
});
