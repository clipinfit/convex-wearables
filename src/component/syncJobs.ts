import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { captureOutgoingEvent } from "./outgoingWebhooks";
import { providerName, syncJobStatus } from "./schema";

const syncPhase = v.union(v.literal("events"), v.literal("dataPoints"), v.literal("summaries"));

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getByUser = query({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("syncJobs")
      .withIndex("by_user", (idx) => idx.eq("userId", args.userId))
      .order("desc")
      .take(args.limit ?? 10);
  },
});

export const getRunning = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    return await ctx.db
      .query("syncJobs")
      .withIndex("by_status", (idx) => idx.eq("status", "running"))
      .collect();
  },
});

export const getById = internalQuery({
  args: {
    jobId: v.id("syncJobs"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.jobId);
  },
});

export const getActiveByIdempotencyKey = internalQuery({
  args: {
    idempotencyKey: v.string(),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("syncJobs")
      .withIndex("by_idempotency_key", (idx) => idx.eq("idempotencyKey", args.idempotencyKey))
      .order("desc")
      .first();

    if (!job) {
      return null;
    }

    return job.status === "queued" || job.status === "running" ? job : null;
  },
});

export const getByWorkflowId = internalQuery({
  args: {
    workflowId: v.string(),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("syncJobs")
      .withIndex("by_workflow", (idx) => idx.eq("workflowId", args.workflowId))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const create = internalMutation({
  args: {
    connectionId: v.id("connections"),
    userId: v.string(),
    provider: providerName,
    mode: v.optional(v.union(v.literal("manual"), v.literal("cron"), v.literal("webhook"))),
    triggerSource: v.optional(v.string()),
    idempotencyKey: v.string(),
    startedAt: v.optional(v.number()),
    windowStart: v.optional(v.number()),
    windowEnd: v.optional(v.number()),
  },
  returns: v.id("syncJobs"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("syncJobs", {
      connectionId: args.connectionId,
      userId: args.userId,
      provider: args.provider,
      mode: args.mode,
      triggerSource: args.triggerSource,
      idempotencyKey: args.idempotencyKey,
      status: "queued",
      startedAt: args.startedAt ?? Date.now(),
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      attempt: 0,
    });
    await captureOutgoingEvent(ctx, {
      userId: args.userId,
      provider: args.provider,
      eventType: "sync.started",
      subjectKind: "sync",
      subjectId: String(id),
      idempotencyKey: `sync:${args.idempotencyKey}:started`,
      data: {
        syncJobId: String(id),
        provider: args.provider,
        mode: args.mode,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
      },
    });
    return id;
  },
});

export const updateStatus = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    status: syncJobStatus,
    error: v.optional(v.string()),
    recordsProcessed: v.optional(v.number()),
    workflowId: v.optional(v.string()),
    attempt: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    cursor: v.optional(v.string()),
    currentPhase: v.optional(syncPhase),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const updates: Record<string, unknown> = { status: args.status };
    if (args.error !== undefined) updates.error = args.error;
    if (args.recordsProcessed !== undefined) updates.recordsProcessed = args.recordsProcessed;
    if (args.workflowId !== undefined) updates.workflowId = args.workflowId;
    if (args.attempt !== undefined) updates.attempt = args.attempt;
    if (args.lastHeartbeatAt !== undefined) updates.lastHeartbeatAt = args.lastHeartbeatAt;
    if (args.cursor !== undefined) updates.cursor = args.cursor;
    if (args.currentPhase !== undefined) updates.currentPhase = args.currentPhase;
    if (args.status === "completed" || args.status === "failed" || args.status === "canceled") {
      updates.completedAt = Date.now();
    }
    await ctx.db.patch(args.jobId, updates);
    if (job && ["completed", "failed"].includes(args.status) && job.status !== args.status)
      await captureOutgoingEvent(ctx, {
        userId: job.userId,
        provider: job.provider,
        eventType: args.status === "completed" ? "sync.completed" : "sync.failed",
        subjectKind: "sync",
        subjectId: String(job._id),
        idempotencyKey: `sync:${job.idempotencyKey}:${args.status}`,
        data: {
          syncJobId: String(job._id),
          provider: job.provider,
          status: args.status,
          recordsProcessed: args.recordsProcessed,
        },
      });
  },
});
