import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type DatabaseReader, internalMutation, internalQuery, query } from "./_generated/server";
import { dataSourceDocumentValidator } from "./dataSources";
import { assertIngestionAllowed } from "./lifecycle";
import { captureOutgoingEvent, outgoingEventFingerprint } from "./outgoingWebhooks";
import { eventCategory, providerName } from "./schema";

type EventReadArgs = {
  userId: string;
  category: "workout" | "sleep";
  provider?: Doc<"dataSources">["provider"];
  dataSourceId?: Id<"dataSources">;
  startDate?: number;
  endDate?: number;
  limit?: number;
  cursor?: string;
};

type SourceAwareEventCursor = {
  version: 1;
  startDatetime: number;
  eventId: string;
};

function parseSourceAwareEventCursor(
  cursor: string | undefined,
):
  | { kind: "none" }
  | { kind: "legacy"; startDatetime: number }
  | { kind: "sourceAware"; value: SourceAwareEventCursor } {
  if (cursor === undefined) return { kind: "none" };

  const legacyTimestamp = Number(cursor);
  if (Number.isFinite(legacyTimestamp)) {
    return { kind: "legacy", startDatetime: legacyTimestamp };
  }

  try {
    const parsed = JSON.parse(cursor) as Partial<SourceAwareEventCursor>;
    if (
      parsed.version === 1 &&
      typeof parsed.startDatetime === "number" &&
      Number.isFinite(parsed.startDatetime) &&
      typeof parsed.eventId === "string" &&
      parsed.eventId.length > 0
    ) {
      return { kind: "sourceAware", value: parsed as SourceAwareEventCursor };
    }
  } catch {
    // Throw the same safe validation error for malformed JSON and shapes.
  }

  throw new Error("cursor is not a valid source-aware event cursor");
}

function compareEventsDescending(left: Doc<"events">, right: Doc<"events">): number {
  const timeDifference = right.startDatetime - left.startDatetime;
  return timeDifference !== 0 ? timeDifference : String(right._id).localeCompare(String(left._id));
}

function encodeSourceAwareEventCursor(event: Doc<"events">): string {
  return JSON.stringify({
    version: 1,
    startDatetime: event.startDatetime,
    eventId: String(event._id),
  } satisfies SourceAwareEventCursor);
}

async function resolveReadableDataSources(db: DatabaseReader, args: EventReadArgs) {
  if (args.dataSourceId) {
    const source = await db.get(args.dataSourceId);
    if (
      !source ||
      source.userId !== args.userId ||
      (args.provider !== undefined && source.provider !== args.provider)
    ) {
      return [];
    }
    return [source];
  }

  if (args.provider === undefined) {
    return await db
      .query("dataSources")
      .withIndex("by_user_provider", (index) => index.eq("userId", args.userId))
      .collect();
  }

  const provider = args.provider;
  return await db
    .query("dataSources")
    .withIndex("by_user_provider", (index) =>
      index.eq("userId", args.userId).eq("provider", provider),
    )
    .collect();
}

async function getEventsForSource(
  db: DatabaseReader,
  source: Doc<"dataSources">,
  args: EventReadArgs,
  take: number,
) {
  const cursor = parseSourceAwareEventCursor(args.cursor);
  const cursorTime =
    cursor.kind === "none"
      ? undefined
      : cursor.kind === "legacy"
        ? cursor.startDatetime
        : cursor.value.startDatetime;

  const upperExclusive =
    cursorTime === undefined
      ? undefined
      : args.endDate === undefined
        ? cursorTime
        : Math.min(cursorTime, args.endDate + 1);

  const olderEvents = await db
    .query("events")
    .withIndex("by_source_category_time", (index) => {
      const range = index.eq("dataSourceId", source._id).eq("category", args.category);
      if (args.startDate !== undefined && upperExclusive !== undefined) {
        return range.gte("startDatetime", args.startDate).lt("startDatetime", upperExclusive);
      }
      if (args.startDate !== undefined && args.endDate !== undefined) {
        return range.gte("startDatetime", args.startDate).lte("startDatetime", args.endDate);
      }
      if (args.startDate !== undefined) {
        return range.gte("startDatetime", args.startDate);
      }
      if (upperExclusive !== undefined) {
        return range.lt("startDatetime", upperExclusive);
      }
      if (args.endDate !== undefined) {
        return range.lte("startDatetime", args.endDate);
      }
      return range;
    })
    .order("desc")
    .take(take);

  if (cursor.kind !== "sourceAware") return olderEvents;

  const cursorInDateRange =
    (args.startDate === undefined || cursor.value.startDatetime >= args.startDate) &&
    (args.endDate === undefined || cursor.value.startDatetime <= args.endDate);
  if (!cursorInDateRange) return olderEvents;

  const sameTimestampEvents = await db
    .query("events")
    .withIndex("by_source_category_time", (index) =>
      index
        .eq("dataSourceId", source._id)
        .eq("category", args.category)
        .eq("startDatetime", cursor.value.startDatetime),
    )
    .collect();

  return [
    ...sameTimestampEvents.filter(
      (event) => String(event._id).localeCompare(cursor.value.eventId) < 0,
    ),
    ...olderEvents,
  ];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get events (workouts or sleep) for a user with cursor-based pagination.
 */
export const getEvents = query({
  args: {
    userId: v.string(),
    category: eventCategory,
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    events: v.array(v.any()),
    nextCursor: v.union(v.string(), v.null()),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 20, 100);

    const buildQuery = () => {
      if (args.cursor) {
        const cursorTime = Number(args.cursor);
        return ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx
              .eq("userId", args.userId)
              .eq("category", args.category)
              .lt("startDatetime", cursorTime),
          )
          .order("desc");
      }

      if (args.startDate !== undefined && args.endDate !== undefined) {
        const { startDate, endDate } = args;
        return ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx
              .eq("userId", args.userId)
              .eq("category", args.category)
              .gte("startDatetime", startDate)
              .lte("startDatetime", endDate),
          )
          .order("desc");
      }
      if (args.startDate !== undefined) {
        const { startDate } = args;
        return ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx
              .eq("userId", args.userId)
              .eq("category", args.category)
              .gte("startDatetime", startDate),
          )
          .order("desc");
      }
      if (args.endDate !== undefined) {
        const { endDate } = args;
        return ctx.db
          .query("events")
          .withIndex("by_user_category_time", (idx) =>
            idx
              .eq("userId", args.userId)
              .eq("category", args.category)
              .lte("startDatetime", endDate),
          )
          .order("desc");
      }
      return ctx.db
        .query("events")
        .withIndex("by_user_category_time", (idx) =>
          idx.eq("userId", args.userId).eq("category", args.category),
        )
        .order("desc");
    };

    const q = buildQuery();

    const results = await q.take(limit + 1);
    const hasMore = results.length > limit;
    const events = hasMore ? results.slice(0, limit) : results;
    const nextCursor =
      hasMore && events.length > 0 ? String(events[events.length - 1].startDatetime) : null;

    return { events, nextCursor, hasMore };
  },
});

/**
 * Get source-aware events without collapsing provider or device streams.
 *
 * Events carry a `dataSourceId`; the matching data-source documents are
 * returned once in the sidecar array to avoid repeating metadata per event.
 */
export const getEventsWithSources = query({
  args: {
    userId: v.string(),
    category: eventCategory,
    provider: v.optional(providerName),
    dataSourceId: v.optional(v.id("dataSources")),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.object({
    events: v.array(v.any()),
    dataSources: v.array(dataSourceDocumentValidator),
    nextCursor: v.union(v.string(), v.null()),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const sources = await resolveReadableDataSources(ctx.db, args);
    const candidates = (
      await Promise.all(
        sources.map((source) => getEventsForSource(ctx.db, source, args, limit + 1)),
      )
    )
      .flat()
      .sort(compareEventsDescending);

    const hasMore = candidates.length > limit;
    const events = candidates.slice(0, limit);
    const representedSourceIds = new Set(events.map((event) => event.dataSourceId));
    const dataSources = sources.filter((source) => representedSourceIds.has(source._id));
    const nextCursor =
      hasMore && events.length > 0 ? encodeSourceAwareEventCursor(events[events.length - 1]) : null;

    return { events, dataSources, nextCursor, hasMore };
  },
});

/**
 * Get a single event by its ID.
 */
export const getEvent = query({
  args: { eventId: v.id("events") },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.eventId);
  },
});

/**
 * Get an event by its external ID (for deduplication checks).
 */
export const getByExternalId = internalQuery({
  args: { externalId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("events")
      .withIndex("by_external_id", (idx) => idx.eq("externalId", args.externalId))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Store a single event (workout or sleep). Deduplicates by externalId if provided.
 */
export const storeEvent = internalMutation({
  args: {
    dataSourceId: v.id("dataSources"),
    userId: v.string(),
    category: eventCategory,
    type: v.optional(v.string()),
    sourceName: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    startDatetime: v.number(),
    endDatetime: v.optional(v.number()),
    externalId: v.optional(v.string()),
    // Workout fields
    heartRateMin: v.optional(v.number()),
    heartRateMax: v.optional(v.number()),
    heartRateAvg: v.optional(v.number()),
    energyBurned: v.optional(v.number()),
    distance: v.optional(v.number()),
    stepsCount: v.optional(v.number()),
    maxSpeed: v.optional(v.number()),
    maxWatts: v.optional(v.number()),
    movingTimeSeconds: v.optional(v.number()),
    totalElevationGain: v.optional(v.number()),
    averageSpeed: v.optional(v.number()),
    averageWatts: v.optional(v.number()),
    elevHigh: v.optional(v.number()),
    elevLow: v.optional(v.number()),
    // Sleep fields
    sleepTotalDurationMinutes: v.optional(v.number()),
    sleepTimeInBedMinutes: v.optional(v.number()),
    sleepEfficiencyScore: v.optional(v.number()),
    sleepDeepMinutes: v.optional(v.number()),
    sleepRemMinutes: v.optional(v.number()),
    sleepLightMinutes: v.optional(v.number()),
    sleepAwakeMinutes: v.optional(v.number()),
    isNap: v.optional(v.boolean()),
    sleepStages: v.optional(
      v.array(
        v.object({
          stage: v.string(),
          startTime: v.number(),
          endTime: v.number(),
        }),
      ),
    ),
  },
  returns: v.id("events"),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.dataSourceId);
    await assertIngestionAllowed(ctx, { userId: args.userId, provider: source?.provider });
    // Deduplicate by externalId
    if (args.externalId) {
      const candidates = await ctx.db
        .query("events")
        .withIndex("by_external_id", (idx) => idx.eq("externalId", args.externalId))
        .collect();
      let existing: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        if (candidate.userId !== args.userId) continue;
        const candidateSource = await ctx.db.get(candidate.dataSourceId);
        if (candidateSource?.provider === source?.provider) {
          existing = candidate;
          break;
        }
      }
      if (existing) {
        // Update existing record
        await ctx.db.patch(existing._id, args);
        await captureOutgoingEvent(ctx, {
          userId: args.userId,
          provider: source?.provider,
          eventType: `${args.category}.upserted`,
          subjectKind: args.category,
          subjectId: String(existing._id),
          idempotencyKey: `${args.category}:${source?.provider ?? "unknown"}:${args.externalId ?? existing._id}:${outgoingEventFingerprint(args)}`,
          data: {
            eventId: String(existing._id),
            category: args.category,
            type: args.type,
            startDatetime: args.startDatetime,
            endDatetime: args.endDatetime,
            externalId: args.externalId,
          },
        });
        return existing._id;
      }
    }

    // Deduplicate by source + start + end
    const existing = await ctx.db
      .query("events")
      .withIndex("by_source_start_end", (idx) =>
        idx
          .eq("dataSourceId", args.dataSourceId)
          .eq("startDatetime", args.startDatetime)
          .eq("endDatetime", args.endDatetime ?? undefined),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, args);
      await captureOutgoingEvent(ctx, {
        userId: args.userId,
        provider: source?.provider,
        eventType: `${args.category}.upserted`,
        subjectKind: args.category,
        subjectId: String(existing._id),
        idempotencyKey: `${args.category}:${source?.provider ?? "unknown"}:${args.externalId ?? existing._id}:${outgoingEventFingerprint(args)}`,
        data: {
          eventId: String(existing._id),
          category: args.category,
          type: args.type,
          startDatetime: args.startDatetime,
          endDatetime: args.endDatetime,
          externalId: args.externalId,
        },
      });
      return existing._id;
    }
    const id = await ctx.db.insert("events", args);
    await captureOutgoingEvent(ctx, {
      userId: args.userId,
      provider: source?.provider,
      eventType: `${args.category}.upserted`,
      subjectKind: args.category,
      subjectId: String(id),
      idempotencyKey: `${args.category}:${source?.provider ?? "unknown"}:${args.externalId ?? id}:${outgoingEventFingerprint(args)}`,
      data: {
        eventId: String(id),
        category: args.category,
        type: args.type,
        startDatetime: args.startDatetime,
        endDatetime: args.endDatetime,
        externalId: args.externalId,
      },
    });
    return id;
  },
});

/**
 * Store a batch of events. Used by sync workflows to write multiple events
 * in a single mutation (must complete within 1 second).
 */
export const storeEventBatch = internalMutation({
  args: {
    events: v.array(v.any()),
  },
  returns: v.array(v.id("events")),
  handler: async (ctx, args) => {
    const ids: Id<"events">[] = [];
    for (const event of args.events) {
      const source = await ctx.db.get(event.dataSourceId as Id<"dataSources">);
      await assertIngestionAllowed(ctx, {
        userId: event.userId,
        provider: source?.provider,
      });
      // Deduplicate by externalId
      if (event.externalId) {
        const candidates = await ctx.db
          .query("events")
          .withIndex("by_external_id", (idx) => idx.eq("externalId", event.externalId))
          .collect();
        let existing: (typeof candidates)[number] | undefined;
        for (const candidate of candidates) {
          if (candidate.userId !== event.userId) continue;
          const candidateSource = await ctx.db.get(candidate.dataSourceId);
          if (candidateSource?.provider === source?.provider) {
            existing = candidate;
            break;
          }
        }
        if (existing) {
          await ctx.db.patch(existing._id, event);
          ids.push(existing._id);
          await captureOutgoingEvent(ctx, {
            userId: event.userId,
            provider: source?.provider,
            eventType: event.category === "workout" ? "workout.upserted" : "sleep.upserted",
            subjectKind: event.category === "workout" ? "workout" : "sleep",
            subjectId: String(existing._id),
            idempotencyKey: `${event.category}:${source?.provider ?? "unknown"}:${event.externalId ?? existing._id}:${outgoingEventFingerprint(event)}`,
            data: {
              eventId: String(existing._id),
              category: event.category,
              type: event.type,
              startDatetime: event.startDatetime,
              endDatetime: event.endDatetime,
              externalId: event.externalId,
            },
          });
          continue;
        }
      }
      const existing = await ctx.db
        .query("events")
        .withIndex("by_source_start_end", (idx) =>
          idx
            .eq("dataSourceId", event.dataSourceId)
            .eq("startDatetime", event.startDatetime)
            .eq("endDatetime", event.endDatetime ?? undefined),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, event);
        ids.push(existing._id);
        await captureOutgoingEvent(ctx, {
          userId: event.userId,
          provider: source?.provider,
          eventType: event.category === "workout" ? "workout.upserted" : "sleep.upserted",
          subjectKind: event.category === "workout" ? "workout" : "sleep",
          subjectId: String(existing._id),
          idempotencyKey: `${event.category}:${source?.provider ?? "unknown"}:${event.externalId ?? existing._id}:${outgoingEventFingerprint(event)}`,
          data: {
            eventId: String(existing._id),
            category: event.category,
            type: event.type,
            startDatetime: event.startDatetime,
            endDatetime: event.endDatetime,
            externalId: event.externalId,
          },
        });
        continue;
      }
      const id = await ctx.db.insert("events", event);
      ids.push(id);
      await captureOutgoingEvent(ctx, {
        userId: event.userId,
        provider: source?.provider,
        eventType: event.category === "workout" ? "workout.upserted" : "sleep.upserted",
        subjectKind: event.category === "workout" ? "workout" : "sleep",
        subjectId: String(id),
        idempotencyKey: `${event.category}:${source?.provider ?? "unknown"}:${event.externalId ?? id}:${outgoingEventFingerprint(event)}`,
        data: {
          eventId: String(id),
          category: event.category,
          type: event.type,
          startDatetime: event.startDatetime,
          endDatetime: event.endDatetime,
          externalId: event.externalId,
        },
      });
    }
    return ids;
  },
});

export const deleteByExternalId = internalMutation({
  args: {
    externalId: v.string(),
    userId: v.optional(v.string()),
    provider: v.optional(providerName),
  },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("events")
      .withIndex("by_external_id", (idx) => idx.eq("externalId", args.externalId))
      .collect();
    let event: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (args.userId && candidate.userId !== args.userId) continue;
      if (args.provider) {
        const source = await ctx.db.get(candidate.dataSourceId);
        if (source?.provider !== args.provider) continue;
      }
      event = candidate;
      break;
    }

    if (event) {
      const segments = await ctx.db
        .query("workoutSegments")
        .withIndex("by_event_kind_index", (index) => index.eq("eventId", event._id))
        .collect();
      const zones = await ctx.db
        .query("workoutZones")
        .withIndex("by_event_kind_zone", (index) => index.eq("eventId", event._id))
        .collect();
      for (const row of [...segments, ...zones]) await ctx.db.delete(row._id);
      const fileJobs = await ctx.db
        .query("garminActivityFileJobs")
        .withIndex("by_event_external_id", (index) => index.eq("eventExternalId", args.externalId))
        .collect();
      for (const job of fileJobs) await ctx.db.delete(job._id);
      const source = await ctx.db.get(event.dataSourceId);
      await captureOutgoingEvent(ctx, {
        userId: event.userId,
        provider: source?.provider,
        eventType: event.category === "workout" ? "workout.deleted" : "sleep.deleted",
        subjectKind: event.category,
        subjectId: String(event._id),
        idempotencyKey: `${event.category}:${source?.provider ?? "unknown"}:${event.externalId ?? event._id}:deleted`,
        data: {
          eventId: String(event._id),
          category: event.category,
          externalId: event.externalId,
        },
      });
      await ctx.db.delete(event._id);
    }
  },
});

/**
 * Delete all events for a user. Used for GDPR/account deletion.
 */
export const deleteUserEvents = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_user_category_time", (idx) => idx.eq("userId", args.userId))
      .collect();
    for (const event of events) {
      const segments = await ctx.db
        .query("workoutSegments")
        .withIndex("by_event_kind_index", (index) => index.eq("eventId", event._id))
        .collect();
      const zones = await ctx.db
        .query("workoutZones")
        .withIndex("by_event_kind_zone", (index) => index.eq("eventId", event._id))
        .collect();
      for (const row of [...segments, ...zones]) await ctx.db.delete(row._id);
      await ctx.db.delete(event._id);
    }
  },
});
