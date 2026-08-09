import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { providerName } from "./schema";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Look up an OAuth state by its state token.
 */
export const getByState = internalQuery({
  args: { state: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (idx) => idx.eq("state", args.state))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Store a new OAuth state. Schedules automatic cleanup after 15 minutes.
 */
export const store = internalMutation({
  args: {
    state: v.string(),
    userId: v.string(),
    provider: providerName,
    codeVerifier: v.optional(v.string()),
    redirectUri: v.optional(v.string()),
  },
  returns: v.id("oauthStates"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("oauthStates", {
      ...args,
      createdAt: Date.now(),
    });

    // Schedule cleanup in 15 minutes
    await ctx.scheduler.runAfter(15 * 60 * 1000, internal.oauthStates.deleteById, {
      id,
    });

    return id;
  },
});

/**
 * Consume an OAuth state (read and delete). Used during the callback.
 */
export const consume = internalMutation({
  args: { state: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (idx) => idx.eq("state", args.state))
      .first();

    if (!record) return null;

    await ctx.db.delete(record._id);
    return record;
  },
});

/**
 * Delete an OAuth state by ID (used by scheduled cleanup).
 */
export const deleteById = internalMutation({
  args: { id: v.id("oauthStates") },
  handler: async (ctx, args) => {
    const record = await ctx.db.get(args.id);
    if (record) {
      await ctx.db.delete(args.id);
    }
  },
});
