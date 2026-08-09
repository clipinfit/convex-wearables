import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { assertIngestionAllowed } from "./lifecycle";
import { captureOutgoingEvent, outgoingEventFingerprint } from "./outgoingWebhooks";
import { providerName } from "./schema";

const summaryMetricsValidator = {
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
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get daily summaries for a user by category and date range.
 * When provider is omitted this returns provider-mixed storage rows and is not
 * a canonical product view for multi-provider apps.
 */
export const getDailySummaries = query({
  args: {
    userId: v.string(),
    provider: v.optional(providerName),
    category: v.string(),
    startDate: v.string(), // "2026-03-01"
    endDate: v.string(), // "2026-03-15"
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    if (args.provider !== undefined) {
      return await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_provider_category_date", (idx) =>
          idx
            .eq("userId", args.userId)
            .eq("provider", args.provider)
            .eq("category", args.category)
            .gte("date", args.startDate)
            .lte("date", args.endDate),
        )
        .collect();
    }

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
    provider: v.optional(providerName),
    date: v.string(),
  },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    if (args.provider !== undefined) {
      return await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_provider_date", (idx) =>
          idx.eq("userId", args.userId).eq("provider", args.provider).eq("date", args.date),
        )
        .collect();
    }

    return await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_date", (idx) => idx.eq("userId", args.userId).eq("date", args.date))
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
    provider: providerName,
    dataSourceId: v.optional(v.id("dataSources")),
    source: v.optional(v.string()),
    originalSourceName: v.optional(v.string()),
    date: v.string(),
    category: v.string(),
    // All metric fields are optional — only provided fields are updated
    ...summaryMetricsValidator,
  },
  returns: v.id("dailySummaries"),
  handler: async (ctx, args) => {
    await assertIngestionAllowed(ctx, args);
    const {
      userId,
      provider,
      dataSourceId,
      source,
      originalSourceName,
      date,
      category,
      ...metrics
    } = args;

    // New writes are provider-scoped. Legacy rows without provider remain
    // readable through unfiltered queries but are not canonical for new ingest.
    const existing = await ctx.db
      .query("dailySummaries")
      .withIndex("by_user_provider_category_date", (idx) =>
        idx.eq("userId", userId).eq("provider", provider).eq("category", category).eq("date", date),
      )
      .first();

    const definedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({
      dataSourceId,
      source,
      originalSourceName,
      ...metrics,
    })) {
      if (value !== undefined) {
        definedFields[key] = value;
      }
    }

    if (existing) {
      await ctx.db.patch(existing._id, definedFields);
      await captureOutgoingEvent(ctx, {
        userId,
        provider,
        eventType: "summary.upserted",
        subjectKind: "summary",
        subjectId: String(existing._id),
        idempotencyKey: `summary:${userId}:${provider}:${category}:${date}:${outgoingEventFingerprint(definedFields)}`,
        data: { summaryId: String(existing._id), provider, category, date },
        snapshotData: {
          summaryId: String(existing._id),
          provider,
          category,
          date,
          metrics: definedFields,
        },
      });
      return existing._id;
    }
    const id = await ctx.db.insert("dailySummaries", {
      userId,
      provider,
      date,
      category,
      ...definedFields,
    });
    await captureOutgoingEvent(ctx, {
      userId,
      provider,
      eventType: "summary.upserted",
      subjectKind: "summary",
      subjectId: String(id),
      idempotencyKey: `summary:${userId}:${provider}:${category}:${date}:${outgoingEventFingerprint(definedFields)}`,
      data: { summaryId: String(id), provider, category, date },
      snapshotData: { summaryId: String(id), provider, category, date, metrics: definedFields },
    });
    return id;
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
