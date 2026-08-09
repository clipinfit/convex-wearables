import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { assertIngestionAllowed } from "./lifecycle";

const status = v.union(
  v.literal("queued"),
  v.literal("processing"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("expired"),
  v.literal("skipped"),
);

export const enqueue = internalMutation({
  args: {
    connectionId: v.id("connections"),
    dataSourceId: v.id("dataSources"),
    userId: v.string(),
    activityId: v.string(),
    callbackUrl: v.string(),
    fileType: v.string(),
    receivedAt: v.number(),
  },
  returns: v.id("garminActivityFileJobs"),
  handler: async (ctx, args) => {
    await assertIngestionAllowed(ctx, { userId: args.userId, provider: "garmin" });
    const existing = await ctx.db
      .query("garminActivityFileJobs")
      .withIndex("by_activity", (index) =>
        index.eq("connectionId", args.connectionId).eq("activityId", args.activityId),
      )
      .first();
    if (existing) {
      if (existing.status !== "completed" && args.fileType.toUpperCase() === "FIT") {
        const expiresAt = args.receivedAt + 24 * 60 * 60 * 1000;
        await ctx.db.patch(existing._id, {
          callbackUrl: args.callbackUrl,
          status: "queued",
          attempts: 0,
          receivedAt: args.receivedAt,
          expiresAt,
          lastError: undefined,
          completedAt: undefined,
        });
        await ctx.scheduler.runAt(expiresAt, internal.garminActivityFileJobs.scrubExpired, {
          jobId: existing._id,
          expiresAt,
        });
      }
      return existing._id;
    }
    const expiresAt = args.receivedAt + 24 * 60 * 60 * 1000;
    const jobId = await ctx.db.insert("garminActivityFileJobs", {
      connectionId: args.connectionId,
      dataSourceId: args.dataSourceId,
      eventExternalId: `garmin-${args.activityId}`,
      activityId: args.activityId,
      callbackUrl: args.callbackUrl,
      fileType: args.fileType,
      status: args.fileType.toUpperCase() === "FIT" ? "queued" : "skipped",
      attempts: 0,
      receivedAt: args.receivedAt,
      expiresAt,
      parserVersion: "fit-file-parser@4",
    });
    await ctx.scheduler.runAt(expiresAt, internal.garminActivityFileJobs.scrubExpired, {
      jobId,
      expiresAt,
    });
    return jobId;
  },
});

export const scrubExpired = internalMutation({
  args: { jobId: v.id("garminActivityFileJobs"), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.expiresAt !== args.expiresAt || job.expiresAt > Date.now()) return null;
    if (job.callbackUrl) {
      await ctx.db.patch(job._id, {
        callbackUrl: undefined,
        status: job.status === "completed" || job.status === "skipped" ? job.status : "expired",
        completedAt: job.completedAt ?? Date.now(),
      });
    }
    return null;
  },
});

export const get = internalQuery({
  args: { jobId: v.id("garminActivityFileJobs") },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.get(args.jobId),
});

export const claim = internalMutation({
  args: { jobId: v.id("garminActivityFileJobs") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || (job.status !== "queued" && job.status !== "failed") || !job.callbackUrl) {
      return false;
    }
    if (job.expiresAt <= Date.now()) {
      await ctx.db.patch(job._id, { status: "expired", callbackUrl: undefined });
      return false;
    }
    await ctx.db.patch(job._id, { status: "processing", attempts: job.attempts + 1 });
    return true;
  },
});

export const finish = internalMutation({
  args: {
    jobId: v.id("garminActivityFileJobs"),
    status,
    error: v.optional(v.string()),
    scrubCallbackUrl: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    await ctx.db.patch(job._id, {
      status: args.status,
      lastError: args.error?.slice(0, 500),
      callbackUrl: args.scrubCallbackUrl ? undefined : job.callbackUrl,
      completedAt: ["completed", "expired", "skipped"].includes(args.status)
        ? Date.now()
        : undefined,
    });
    return null;
  },
});
