import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { providerName } from "./schema";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get menstrual cycle records for a user within a date range.
 */
export const getByUserDateRange = query({
  args: {
    userId: v.string(),
    startDate: v.string(), // ISO date "2026-01-01"
    endDate: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("menstrualCycles")
      .withIndex("by_user_date", (idx) =>
        idx
          .eq("userId", args.userId)
          .gte("periodStartDate", args.startDate)
          .lte("periodStartDate", args.endDate),
      )
      .collect();
  },
});

/**
 * Get the latest menstrual cycle record for a user.
 */
export const getLatest = query({
  args: { userId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("menstrualCycles")
      .withIndex("by_user_date", (idx) => idx.eq("userId", args.userId))
      .order("desc")
      .first();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Upsert a menstrual cycle record. Deduplicates by externalId.
 */
export const upsert = internalMutation({
  args: {
    userId: v.string(),
    provider: providerName,
    externalId: v.optional(v.string()),
    periodStartDate: v.string(),
    dayInCycle: v.optional(v.number()),
    cycleLength: v.optional(v.number()),
    predictedCycleLength: v.optional(v.number()),
    periodLength: v.optional(v.number()),
    currentPhase: v.optional(v.number()),
    currentPhaseType: v.optional(v.string()),
    lengthOfCurrentPhase: v.optional(v.number()),
    daysUntilNextPhase: v.optional(v.number()),
    isPredictedCycle: v.optional(v.boolean()),
    fertileWindowStart: v.optional(v.number()),
    lengthOfFertileWindow: v.optional(v.number()),
    lastUpdatedAt: v.optional(v.number()),
    isPregnant: v.optional(v.boolean()),
    pregnancyDueDate: v.optional(v.string()),
    pregnancyOriginalDueDate: v.optional(v.string()),
    pregnancyCycleStartDate: v.optional(v.string()),
    pregnancyTitle: v.optional(v.string()),
    numberOfBabies: v.optional(v.string()),
  },
  returns: v.id("menstrualCycles"),
  handler: async (ctx, args) => {
    // Dedup by externalId
    if (args.externalId) {
      const existing = await ctx.db
        .query("menstrualCycles")
        .withIndex("by_external_id", (idx) => idx.eq("externalId", args.externalId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, args);
        return existing._id;
      }
    }

    // Dedup by user + periodStartDate
    const existing = await ctx.db
      .query("menstrualCycles")
      .withIndex("by_user_date", (idx) =>
        idx.eq("userId", args.userId).eq("periodStartDate", args.periodStartDate),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, args);
      return existing._id;
    }

    return await ctx.db.insert("menstrualCycles", args);
  },
});

/**
 * Delete all menstrual cycle data for a user.
 */
export const deleteByUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("menstrualCycles")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();
    for (const r of records) {
      await ctx.db.delete(r._id);
    }
  },
});
