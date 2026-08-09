import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { backfillStatus, providerName } from "./schema";
import { durableWorkflow } from "./workflowManager";

export const backfillSignal = v.object({
  kind: v.union(v.literal("webhook"), v.literal("timeout")),
  dataType: v.string(),
  itemCount: v.optional(v.number()),
});

export const getActiveByConnection = internalQuery({
  args: {
    connectionId: v.id("connections"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    const jobs = await ctx.db
      .query("backfillJobs")
      .withIndex("by_connection", (idx) => idx.eq("connectionId", args.connectionId))
      .order("desc")
      .take(10);

    return jobs.find((job) => job.status === "queued" || job.status === "running") ?? null;
  },
});

export const getById = internalQuery({
  args: {
    backfillJobId: v.id("backfillJobs"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.backfillJobId);
  },
});

export const getLatestByConnection = query({
  args: {
    connectionId: v.id("connections"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("backfillJobs")
      .withIndex("by_connection", (idx) => idx.eq("connectionId", args.connectionId))
      .order("desc")
      .first();
  },
});

export const create = internalMutation({
  args: {
    connectionId: v.id("connections"),
    userId: v.string(),
    provider: providerName,
    dataType: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  returns: v.id("backfillJobs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("backfillJobs", {
      connectionId: args.connectionId,
      userId: args.userId,
      provider: args.provider,
      dataType: args.dataType,
      status: "queued",
      startedAt: Date.now(),
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      completedDataTypes: [],
      currentAttempt: 0,
    });
  },
});

export const updateStatus = internalMutation({
  args: {
    backfillJobId: v.id("backfillJobs"),
    status: backfillStatus,
    workflowId: v.optional(v.string()),
    error: v.optional(v.string()),
    currentDataType: v.optional(v.string()),
    currentAttempt: v.optional(v.number()),
    currentEventId: v.optional(v.string()),
    completedDataTypes: v.optional(v.array(v.string())),
    lastHeartbeatAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      status: args.status,
    };
    if (args.workflowId !== undefined) updates.workflowId = args.workflowId;
    if (args.error !== undefined) updates.error = args.error;
    if (args.currentDataType !== undefined) updates.currentDataType = args.currentDataType;
    if (args.currentAttempt !== undefined) updates.currentAttempt = args.currentAttempt;
    if (args.currentEventId !== undefined) updates.currentEventId = args.currentEventId;
    if (args.completedDataTypes !== undefined) updates.completedDataTypes = args.completedDataTypes;
    if (args.lastHeartbeatAt !== undefined) updates.lastHeartbeatAt = args.lastHeartbeatAt;
    if (args.status === "completed" || args.status === "failed" || args.status === "canceled") {
      updates.completedAt = Date.now();
      updates.currentEventId = undefined;
    }
    await ctx.db.patch(args.backfillJobId, updates);
  },
});

export const beginAwaitingType = internalMutation({
  args: {
    backfillJobId: v.id("backfillJobs"),
    workflowId: v.string(),
    dataType: v.string(),
    attempt: v.number(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const eventId = await durableWorkflow.createEvent(ctx, {
      workflowId: args.workflowId as never,
      name: `garmin-backfill:${args.dataType}:${args.attempt}`,
    });

    await ctx.db.patch(args.backfillJobId, {
      status: "running",
      currentDataType: args.dataType,
      currentAttempt: args.attempt,
      currentEventId: eventId,
      lastHeartbeatAt: Date.now(),
    });

    return eventId;
  },
});

export const markTypeCompleted = internalMutation({
  args: {
    backfillJobId: v.id("backfillJobs"),
    dataType: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.backfillJobId);
    if (!job) return;

    const completed = new Set(job.completedDataTypes ?? []);
    completed.add(args.dataType);

    await ctx.db.patch(args.backfillJobId, {
      completedDataTypes: Array.from(completed),
      currentDataType: undefined,
      currentAttempt: undefined,
      currentEventId: undefined,
      lastHeartbeatAt: Date.now(),
    });
  },
});

export const scheduleTimeout = internalMutation({
  args: {
    backfillJobId: v.id("backfillJobs"),
    eventId: v.string(),
    dataType: v.string(),
    delayMs: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(args.delayMs, internal.backfillJobs.emitTimeout, {
      backfillJobId: args.backfillJobId,
      eventId: args.eventId,
      dataType: args.dataType,
    });
  },
});

export const emitTimeout = internalMutation({
  args: {
    backfillJobId: v.id("backfillJobs"),
    eventId: v.string(),
    dataType: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.backfillJobId);
    if (
      !job ||
      job.status !== "running" ||
      job.currentEventId !== args.eventId ||
      job.currentDataType !== args.dataType
    ) {
      return;
    }

    try {
      await durableWorkflow.sendEvent(ctx, {
        id: args.eventId as never,
        value: {
          kind: "timeout",
          dataType: args.dataType,
        },
      });
    } catch {
      // Timeout events are best-effort. If the workflow already moved on,
      // duplicate or stale sends should not fail the scheduler.
    }
  },
});

export const signalWebhookData = internalMutation({
  args: {
    connectionId: v.id("connections"),
    dataType: v.string(),
    itemCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const activeJob = await ctx.db
      .query("backfillJobs")
      .withIndex("by_connection", (idx) => idx.eq("connectionId", args.connectionId))
      .order("desc")
      .first();

    if (
      !activeJob ||
      activeJob.status !== "running" ||
      activeJob.currentDataType !== args.dataType ||
      !activeJob.currentEventId
    ) {
      return;
    }

    try {
      await durableWorkflow.sendEvent(ctx, {
        id: activeJob.currentEventId as never,
        value: {
          kind: "webhook",
          dataType: args.dataType,
          itemCount: args.itemCount,
        },
      });
      await ctx.db.patch(activeJob._id, {
        currentEventId: undefined,
        lastHeartbeatAt: Date.now(),
      });
    } catch {
      // Duplicate Garmin webhook pushes should not fail ingestion.
    }
  },
});
