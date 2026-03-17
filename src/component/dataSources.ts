import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { providerName } from "./schema";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all data sources for a user.
 */
export const getByUser = query({
  args: { userId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();
  },
});

/**
 * Get data sources for a user + provider combination.
 */
export const getByUserProvider = query({
  args: {
    userId: v.string(),
    provider: providerName,
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) =>
        idx.eq("userId", args.userId).eq("provider", args.provider),
      )
      .collect();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Get or create a data source. Used during data ingestion to ensure
 * a data source exists for a given user/provider/device combination.
 */
export const getOrCreate = mutation({
  args: {
    userId: v.string(),
    provider: providerName,
    connectionId: v.optional(v.id("connections")),
    deviceModel: v.optional(v.string()),
    softwareVersion: v.optional(v.string()),
    source: v.optional(v.string()),
    deviceType: v.optional(v.string()),
    originalSourceName: v.optional(v.string()),
  },
  returns: v.id("dataSources"),
  handler: async (ctx, args) => {
    // Look for existing data source matching this user/provider/device/source
    const existing = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider_device", (idx) =>
        idx
          .eq("userId", args.userId)
          .eq("provider", args.provider)
          .eq("deviceModel", args.deviceModel ?? undefined)
          .eq("source", args.source ?? undefined),
      )
      .first();

    if (existing) {
      // Update fields that may have changed
      if (
        args.softwareVersion !== existing.softwareVersion ||
        args.deviceType !== existing.deviceType
      ) {
        await ctx.db.patch(existing._id, {
          softwareVersion: args.softwareVersion,
          deviceType: args.deviceType,
          connectionId: args.connectionId ?? existing.connectionId,
        });
      }
      return existing._id;
    }

    return await ctx.db.insert("dataSources", args);
  },
});

/**
 * Delete all data sources for a user. Used during account deletion.
 */
export const deleteByUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();

    for (const source of sources) {
      await ctx.db.delete(source._id);
    }
  },
});
