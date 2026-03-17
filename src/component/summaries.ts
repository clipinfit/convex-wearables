import { v } from "convex/values";
import { query, internalQuery, internalMutation } from "./_generated/server";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get daily summaries for a user by category and date range.
 * Returns one document per day — very efficient (365 docs for a full year).
 */
export const getDailySummaries = query({
  args: {
    userId: v.string(),
    category: v.string(),
    startDate: v.string(), // "2026-03-01"
    endDate: v.string(), // "2026-03-15"
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_category_date", (idx) =>
        idx
          .eq("userId", args.userId)
          .eq("category", args.category)
          .gte("date", args.startDate)
          .lte("date", args.endDate),
      )
      .collect();
  },
});

/**
 * Get all summaries for a user on a specific date (across all categories).
 */
export const getByUserDate = internalQuery({
  args: {
    userId: v.string(),
    date: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_date", (idx) =>
        idx.eq("userId", args.userId).eq("date", args.date),
      )
      .collect();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Upsert a daily summary. Called during data ingestion to update
 * precomputed aggregates for the affected date.
 */
export const upsert = internalMutation({
  args: {
    userId: v.string(),
    date: v.string(),
    category: v.string(),
    // All metric fields are optional — only provided fields are updated
    totalSteps: v.optional(v.number()),
    totalCalories: v.optional(v.number()),
    activeCalories: v.optional(v.number()),
    activeMinutes: v.optional(v.number()),
    totalDistance: v.optional(v.number()),
    floorsClimbed: v.optional(v.number()),
    avgHeartRate: v.optional(v.number()),
    maxHeartRate: v.optional(v.number()),
    minHeartRate: v.optional(v.number()),
    sleepDurationMinutes: v.optional(v.number()),
    sleepEfficiency: v.optional(v.number()),
    deepSleepMinutes: v.optional(v.number()),
    remSleepMinutes: v.optional(v.number()),
    lightSleepMinutes: v.optional(v.number()),
    awakeDuringMinutes: v.optional(v.number()),
    timeInBedMinutes: v.optional(v.number()),
    hrvAvg: v.optional(v.number()),
    hrvRmssd: v.optional(v.number()),
    restingHeartRate: v.optional(v.number()),
    recoveryScore: v.optional(v.number()),
    weight: v.optional(v.number()),
    bodyFatPercentage: v.optional(v.number()),
    bodyMassIndex: v.optional(v.number()),
    leanBodyMass: v.optional(v.number()),
    bodyTemperature: v.optional(v.number()),
    avgStressLevel: v.optional(v.number()),
    bodyBattery: v.optional(v.number()),
    spo2Avg: v.optional(v.number()),
  },
  returns: v.id("dailySummaries"),
  handler: async (ctx, args) => {
    const { userId, date, category, ...metrics } = args;

    // Find existing summary for this user/date/category
    const existing = await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_category_date", (idx) =>
        idx.eq("userId", userId).eq("category", category).eq("date", date),
      )
      .first();

    // Filter out undefined values from metrics
    const definedMetrics: Record<string, number> = {};
    for (const [key, value] of Object.entries(metrics)) {
      if (value !== undefined) {
        definedMetrics[key] = value;
      }
    }

    if (existing) {
      await ctx.db.patch(existing._id, definedMetrics);
      return existing._id;
    }

    return await ctx.db.insert("dailySummaries", {
      userId,
      date,
      category,
      ...definedMetrics,
    });
  },
});

/**
 * Delete all summaries for a user. Used during account deletion.
 */
export const deleteByUser = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const summaries = await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_date", (idx) => idx.eq("userId", args.userId))
      .collect();

    for (const summary of summaries) {
      await ctx.db.delete(summary._id);
    }
  },
});
