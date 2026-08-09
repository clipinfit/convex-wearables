import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx, mutation, query } from "./_generated/server";
import { assertIngestionAllowed } from "./lifecycle";
import { captureOutgoingEvent, outgoingEventFingerprint } from "./outgoingWebhooks";
import { providerName } from "./schema";

export const workoutSegmentKind = v.union(
  v.literal("lap"),
  v.literal("split"),
  v.literal("length"),
  v.literal("set"),
);
export const workoutZoneKind = v.union(v.literal("heart_rate"), v.literal("power"));

const segmentInput = v.object({
  kind: workoutSegmentKind,
  index: v.number(),
  startDatetime: v.optional(v.number()),
  elapsedSeconds: v.optional(v.number()),
  timerSeconds: v.optional(v.number()),
  distanceMeters: v.optional(v.number()),
  averageHeartRate: v.optional(v.number()),
  maxHeartRate: v.optional(v.number()),
  averageSpeed: v.optional(v.number()),
  maxSpeed: v.optional(v.number()),
  averagePower: v.optional(v.number()),
  maxPower: v.optional(v.number()),
  averageCadence: v.optional(v.number()),
  strokes: v.optional(v.number()),
  exercise: v.optional(v.string()),
  repetitions: v.optional(v.number()),
  weight: v.optional(v.number()),
  weightUnit: v.optional(v.string()),
  setType: v.optional(v.string()),
});

const zoneInput = v.object({
  kind: workoutZoneKind,
  zone: v.number(),
  lowerBound: v.optional(v.number()),
  upperBound: v.optional(v.number()),
  seconds: v.number(),
});

export const getWorkoutEnrichment = query({
  args: { eventId: v.id("events") },
  returns: v.object({ event: v.any(), segments: v.array(v.any()), zones: v.array(v.any()) }),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    const segments = await ctx.db
      .query("workoutSegments")
      .withIndex("by_event_kind_index", (index) => index.eq("eventId", args.eventId))
      .collect();
    const zones = await ctx.db
      .query("workoutZones")
      .withIndex("by_event_kind_zone", (index) => index.eq("eventId", args.eventId))
      .collect();
    return { event, segments, zones };
  },
});

async function replaceDetails(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    userId: string;
    provider:
      | "garmin"
      | "suunto"
      | "polar"
      | "whoop"
      | "strava"
      | "apple"
      | "samsung"
      | "google"
      | "synthetic";
    segments: Array<
      Record<string, unknown> & { kind: "lap" | "split" | "length" | "set"; index: number }
    >;
    zones: Array<
      Record<string, unknown> & { kind: "heart_rate" | "power"; zone: number; seconds: number }
    >;
  },
) {
  if (args.segments.length > 500 || args.zones.length > 20) {
    throw new Error("Workout enrichment exceeds the bounded write limits");
  }
  const event = await ctx.db.get(args.eventId);
  if (!event || event.userId !== args.userId || event.category !== "workout") {
    throw new Error("Workout event not found for enrichment");
  }
  const dataSource = await ctx.db.get(event.dataSourceId);
  if (!dataSource || dataSource.provider !== args.provider) {
    throw new Error("Workout enrichment provider must match the event data source");
  }
  await assertIngestionAllowed(ctx, { userId: args.userId, provider: args.provider });

  const oldSegments = await ctx.db
    .query("workoutSegments")
    .withIndex("by_event_kind_index", (index) => index.eq("eventId", args.eventId))
    .collect();
  const oldZones = await ctx.db
    .query("workoutZones")
    .withIndex("by_event_kind_zone", (index) => index.eq("eventId", args.eventId))
    .collect();
  for (const row of [...oldSegments, ...oldZones]) await ctx.db.delete(row._id);

  for (const segment of args.segments) {
    await ctx.db.insert("workoutSegments", {
      ...segment,
      eventId: args.eventId,
      userId: args.userId,
      provider: args.provider,
      schemaVersion: 1,
    });
  }
  for (const zone of args.zones) {
    await ctx.db.insert("workoutZones", {
      ...zone,
      eventId: args.eventId,
      userId: args.userId,
      provider: args.provider,
      schemaVersion: 1,
    });
  }
  await captureOutgoingEvent(ctx, {
    userId: args.userId,
    provider: args.provider,
    eventType: "workout.enriched",
    subjectKind: "workout",
    subjectId: String(args.eventId),
    idempotencyKey: `workout:${args.eventId}:enriched:${outgoingEventFingerprint({ segments: args.segments, zones: args.zones })}`,
    data: {
      eventId: String(args.eventId),
      provider: args.provider,
      segmentCount: args.segments.length,
      zoneCount: args.zones.length,
    },
  });
  return { segments: args.segments.length, zones: args.zones.length };
}

export const replaceWorkoutEnrichment = internalMutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
    provider: providerName,
    segments: v.array(segmentInput),
    zones: v.array(zoneInput),
  },
  returns: v.object({ segments: v.number(), zones: v.number() }),
  handler: replaceDetails,
});

/** Provider-neutral host ingestion escape hatch for parsers maintained outside the component. */
export const upsertWorkoutEnrichment = mutation({
  args: {
    eventId: v.id("events"),
    userId: v.string(),
    provider: providerName,
    segments: v.array(segmentInput),
    zones: v.array(zoneInput),
  },
  returns: v.object({ segments: v.number(), zones: v.number() }),
  handler: replaceDetails,
});
