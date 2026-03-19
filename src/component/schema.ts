import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Provider name union — all supported wearable providers.
 */
export const providerName = v.union(
  v.literal("garmin"),
  v.literal("suunto"),
  v.literal("polar"),
  v.literal("whoop"),
  v.literal("strava"),
  v.literal("apple"),
  v.literal("samsung"),
  v.literal("google"),
);

/**
 * Connection status enum.
 */
export const connectionStatus = v.union(
  v.literal("active"),
  v.literal("inactive"),
  v.literal("revoked"),
  v.literal("expired"),
  v.literal("error"),
);

/**
 * Event category — top-level classification.
 */
export const eventCategory = v.union(v.literal("workout"), v.literal("sleep"));

/**
 * Sync job status.
 */
export const syncJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);

/**
 * Backfill job status.
 */
export const backfillStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export default defineSchema({
  // -------------------------------------------------------------------------
  // Connections — OAuth tokens + provider link per user
  // -------------------------------------------------------------------------
  connections: defineTable({
    userId: v.string(), // app-provided user identifier
    provider: providerName,
    providerUserId: v.optional(v.string()),
    providerUsername: v.optional(v.string()),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()), // unix ms
    scope: v.optional(v.string()),
    status: connectionStatus,
    lastSyncedAt: v.optional(v.number()), // unix ms
  })
    .index("by_user", ["userId"])
    .index("by_user_provider", ["userId", "provider"])
    .index("by_provider_user", ["provider", "providerUserId"])
    .index("by_status", ["status"]),

  // -------------------------------------------------------------------------
  // Data Sources — user + provider + device combination
  // -------------------------------------------------------------------------
  dataSources: defineTable({
    userId: v.string(),
    provider: providerName,
    connectionId: v.optional(v.id("connections")),
    deviceModel: v.optional(v.string()),
    softwareVersion: v.optional(v.string()),
    source: v.optional(v.string()),
    deviceType: v.optional(v.string()),
    originalSourceName: v.optional(v.string()),
  })
    .index("by_user_provider", ["userId", "provider"])
    .index("by_user_provider_device", ["userId", "provider", "deviceModel", "source"])
    .index("by_connection", ["connectionId"]),

  // -------------------------------------------------------------------------
  // Data Points — time-series health metrics (heart rate, steps, SpO2, etc.)
  // -------------------------------------------------------------------------
  dataPoints: defineTable({
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(), // "heart_rate", "steps", "spo2", etc.
    recordedAt: v.number(), // unix ms
    value: v.number(),
    externalId: v.optional(v.string()),
  })
    .index("by_source_type_time", ["dataSourceId", "seriesType", "recordedAt"])
    .index("by_type_time", ["seriesType", "recordedAt"]),

  // -------------------------------------------------------------------------
  // Events — workouts and sleep sessions
  // -------------------------------------------------------------------------
  events: defineTable({
    dataSourceId: v.id("dataSources"),
    userId: v.string(), // denormalized for direct user queries
    category: eventCategory,
    type: v.optional(v.string()), // "running", "cycling", "night_sleep", etc.
    sourceName: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    startDatetime: v.number(), // unix ms
    endDatetime: v.optional(v.number()), // unix ms
    externalId: v.optional(v.string()),

    // Workout detail fields (present when category == "workout")
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

    // Sleep detail fields (present when category == "sleep")
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
          stage: v.string(), // "deep", "rem", "light", "awake"
          startTime: v.number(), // unix ms
          endTime: v.number(), // unix ms
        }),
      ),
    ),
  })
    .index("by_user_category_time", ["userId", "category", "startDatetime"])
    .index("by_source_category_time", ["dataSourceId", "category", "startDatetime"])
    .index("by_source_start_end", ["dataSourceId", "startDatetime", "endDatetime"])
    .index("by_external_id", ["externalId"]),

  // -------------------------------------------------------------------------
  // Daily Summaries — precomputed daily aggregates
  // -------------------------------------------------------------------------
  dailySummaries: defineTable({
    userId: v.string(),
    date: v.string(), // "2026-03-15" (ISO date string)
    category: v.string(), // "activity" | "sleep" | "recovery" | "body"

    // Activity metrics
    totalSteps: v.optional(v.number()),
    totalCalories: v.optional(v.number()),
    activeCalories: v.optional(v.number()),
    activeMinutes: v.optional(v.number()),
    totalDistance: v.optional(v.number()),
    floorsClimbed: v.optional(v.number()),
    avgHeartRate: v.optional(v.number()),
    maxHeartRate: v.optional(v.number()),
    minHeartRate: v.optional(v.number()),

    // Sleep metrics
    sleepDurationMinutes: v.optional(v.number()),
    sleepEfficiency: v.optional(v.number()),
    deepSleepMinutes: v.optional(v.number()),
    remSleepMinutes: v.optional(v.number()),
    lightSleepMinutes: v.optional(v.number()),
    awakeDuringMinutes: v.optional(v.number()),
    timeInBedMinutes: v.optional(v.number()),

    // Recovery metrics
    hrvAvg: v.optional(v.number()),
    hrvRmssd: v.optional(v.number()),
    restingHeartRate: v.optional(v.number()),
    recoveryScore: v.optional(v.number()),

    // Body metrics
    weight: v.optional(v.number()),
    bodyFatPercentage: v.optional(v.number()),
    bodyMassIndex: v.optional(v.number()),
    leanBodyMass: v.optional(v.number()),
    bodyTemperature: v.optional(v.number()),

    // Stress / other
    avgStressLevel: v.optional(v.number()),
    bodyBattery: v.optional(v.number()),
    spo2Avg: v.optional(v.number()),
  })
    .index("by_user_category_date", ["userId", "category", "date"])
    .index("by_user_date", ["userId", "date"]),

  // -------------------------------------------------------------------------
  // Sync Jobs — workflow tracking for data syncs
  // -------------------------------------------------------------------------
  syncJobs: defineTable({
    connectionId: v.id("connections"),
    userId: v.string(),
    provider: providerName,
    mode: v.optional(v.union(v.literal("manual"), v.literal("cron"), v.literal("webhook"))),
    triggerSource: v.optional(v.string()),
    idempotencyKey: v.string(),
    status: syncJobStatus,
    startedAt: v.number(), // unix ms
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    recordsProcessed: v.optional(v.number()),
    workflowId: v.optional(v.string()),
    windowStart: v.optional(v.number()),
    windowEnd: v.optional(v.number()),
    attempt: v.optional(v.number()),
    lastHeartbeatAt: v.optional(v.number()),
    cursor: v.optional(v.string()),
    currentPhase: v.optional(
      v.union(v.literal("events"), v.literal("dataPoints"), v.literal("summaries")),
    ),
  })
    .index("by_user", ["userId"])
    .index("by_connection", ["connectionId"])
    .index("by_user_provider", ["userId", "provider"])
    .index("by_user_status", ["userId", "status"])
    .index("by_status", ["status"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_workflow", ["workflowId"]),

  // -------------------------------------------------------------------------
  // OAuth States — temporary state for OAuth PKCE flows
  // -------------------------------------------------------------------------
  oauthStates: defineTable({
    state: v.string(), // random state token
    userId: v.string(),
    provider: providerName,
    codeVerifier: v.optional(v.string()), // PKCE
    redirectUri: v.optional(v.string()),
    createdAt: v.number(), // unix ms
  }).index("by_state", ["state"]),

  // -------------------------------------------------------------------------
  // Provider Settings — which providers are enabled + config
  // -------------------------------------------------------------------------
  providerSettings: defineTable({
    provider: providerName,
    isEnabled: v.boolean(),
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
    subscriptionKey: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
  }).index("by_provider", ["provider"]),

  // -------------------------------------------------------------------------
  // Provider Priorities — sync order when multiple providers have same data
  // -------------------------------------------------------------------------
  providerPriorities: defineTable({
    provider: providerName,
    priority: v.number(), // 1 = highest
  })
    .index("by_provider", ["provider"])
    .index("by_priority", ["priority"]),

  // -------------------------------------------------------------------------
  // Menstrual Cycle Tracking (MCT) — Women's Health data
  // -------------------------------------------------------------------------
  menstrualCycles: defineTable({
    userId: v.string(),
    provider: providerName,
    externalId: v.optional(v.string()), // summaryId from provider
    periodStartDate: v.string(), // "2026-03-01" ISO date
    dayInCycle: v.optional(v.number()),
    cycleLength: v.optional(v.number()),
    predictedCycleLength: v.optional(v.number()),
    periodLength: v.optional(v.number()),
    currentPhase: v.optional(v.number()), // numeric phase ID
    currentPhaseType: v.optional(v.string()), // "MENSTRUAL", "FOLLICULAR", "OVULATION", "LUTEAL", "SECOND_TRIMESTER", etc.
    lengthOfCurrentPhase: v.optional(v.number()),
    daysUntilNextPhase: v.optional(v.number()),
    isPredictedCycle: v.optional(v.boolean()),
    fertileWindowStart: v.optional(v.number()), // day in cycle
    lengthOfFertileWindow: v.optional(v.number()),
    lastUpdatedAt: v.optional(v.number()), // unix ms

    // Pregnancy data (present when in pregnant phase)
    isPregnant: v.optional(v.boolean()),
    pregnancyDueDate: v.optional(v.string()), // "2026-09-15" ISO date
    pregnancyOriginalDueDate: v.optional(v.string()),
    pregnancyCycleStartDate: v.optional(v.string()),
    pregnancyTitle: v.optional(v.string()),
    numberOfBabies: v.optional(v.string()), // "SINGLE", "TWINS", etc.
  })
    .index("by_user_date", ["userId", "periodStartDate"])
    .index("by_user_provider", ["userId", "provider"])
    .index("by_external_id", ["externalId"]),

  // -------------------------------------------------------------------------
  // Backfill Jobs — tracks long-running backfill operations (e.g. Garmin)
  // -------------------------------------------------------------------------
  backfillJobs: defineTable({
    connectionId: v.id("connections"),
    userId: v.string(),
    provider: providerName,
    dataType: v.string(), // "full" for a full run; current type tracked separately
    status: backfillStatus,
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    workflowId: v.optional(v.string()),
    windowStart: v.optional(v.number()),
    windowEnd: v.optional(v.number()),
    currentDataType: v.optional(v.string()),
    currentAttempt: v.optional(v.number()),
    currentEventId: v.optional(v.string()),
    completedDataTypes: v.optional(v.array(v.string())),
    lastHeartbeatAt: v.optional(v.number()),
  })
    .index("by_connection", ["connectionId"])
    .index("by_connection_type", ["connectionId", "dataType"])
    .index("by_status", ["status"])
    .index("by_workflow", ["workflowId"]),
});
