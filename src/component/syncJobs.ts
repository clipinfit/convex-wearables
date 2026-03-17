import { v } from "convex/values";
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { providerName, syncJobStatus } from "./schema";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get sync jobs for a user, most recent first.
 */
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

/**
 * Get running sync jobs (for monitoring).
 */
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

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a new sync job.
 */
export const create = mutation({
  args: {
    userId: v.string(),
    provider: v.optional(providerName),
    status: v.optional(syncJobStatus),
    startedAt: v.optional(v.number()),
  },
  returns: v.id("syncJobs"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("syncJobs", {
      userId: args.userId,
      provider: args.provider,
      status: args.status ?? "pending",
      startedAt: args.startedAt ?? Date.now(),
    });
  },
});

/**
 * Update sync job status.
 */
export const updateStatus = internalMutation({
  args: {
    jobId: v.id("syncJobs"),
    status: syncJobStatus,
    error: v.optional(v.string()),
    recordsProcessed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.error !== undefined) updates.error = args.error;
    if (args.recordsProcessed !== undefined)
      updates.recordsProcessed = args.recordsProcessed;
    if (args.status === "completed" || args.status === "failed") {
      updates.completedAt = Date.now();
    }
    await ctx.db.patch(args.jobId, updates);
  },
});
