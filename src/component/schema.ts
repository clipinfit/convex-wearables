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
  v.literal("synthetic"),
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

/**
 * Durable health-data deletion operation scope and status.
 */
export const dataDeletionScope = v.union(v.literal("provider"), v.literal("user"));

export const dataDeletionStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("completed"),
  v.literal("completed_with_warnings"),
  v.literal("failed"),
  v.literal("canceled"),
);

export const providerDeregistrationStatus = v.union(
  v.literal("not_requested"),
  v.literal("pending"),
  v.literal("completed"),
  v.literal("partially_completed"),
  v.literal("unsupported"),
  v.literal("failed"),
);

export const liveWebhookProvider = v.union(
  v.literal("polar"),
  v.literal("whoop"),
  v.literal("suunto"),
);

export const providerWebhookReceiptStatus = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("waiting_for_connection"),
  v.literal("completed"),
  v.literal("ignored"),
  v.literal("failed"),
  v.literal("canceled"),
);

export const providerWebhookRegistrationStatus = v.union(
  v.literal("unconfigured"),
  v.literal("pending_verification"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("deactivated"),
  v.literal("error"),
);

export const outgoingWebhookEndpointStatus = v.union(
  v.literal("pending_verification"),
  v.literal("active"),
  v.literal("paused"),
  v.literal("disabled"),
  v.literal("deleted"),
);

export const outgoingWebhookDeliveryStatus = v.union(
  v.literal("pending"),
  v.literal("delivering"),
  v.literal("retry_scheduled"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("canceled"),
);

/**
 * Supported rollup aggregations.
 */
export const timeSeriesAggregation = v.union(
  v.literal("avg"),
  v.literal("min"),
  v.literal("max"),
  v.literal("last"),
  v.literal("count"),
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
    .index("by_provider_username", ["provider", "providerUsername"])
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
    .index("by_source_time", ["dataSourceId", "recordedAt"])
    .index("by_type_time", ["seriesType", "recordedAt"]),

  // -------------------------------------------------------------------------
  // Time-Series Rollups — bucketed storage for dense historical series
  // -------------------------------------------------------------------------
  timeSeriesRollups: defineTable({
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(),
    bucketMs: v.number(),
    bucketStart: v.number(),
    bucketEnd: v.number(),
    avg: v.number(),
    min: v.number(),
    max: v.number(),
    last: v.number(),
    lastRecordedAt: v.number(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_type_bucket", ["dataSourceId", "seriesType", "bucketStart"])
    .index("by_source_type_bucket_size", ["dataSourceId", "seriesType", "bucketMs", "bucketStart"])
    .index("by_source_bucket", ["dataSourceId", "bucketStart"])
    .index("by_type_bucket", ["seriesType", "bucketStart"]),

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

  // Provider-neutral detail attached to a summary workout event.
  workoutSegments: defineTable({
    eventId: v.id("events"),
    userId: v.string(),
    provider: providerName,
    kind: v.union(v.literal("lap"), v.literal("split"), v.literal("length"), v.literal("set")),
    index: v.number(),
    startDatetime: v.optional(v.number()),
    elapsedSeconds: v.optional(v.number()),
    timerSeconds: v.optional(v.number()),
    distanceMeters: v.optional(v.number()),
    averageHeartRate: v.optional(v.number()),
    maxHeartRate: v.optional(v.number()),
    averageSpeed: v.optional(v.number()),
    maxSpeed: v.optional(v.number()),
    averagePower: v.optional(v.number()),
    maxPower: v.optional(v.number()),
    averageCadence: v.optional(v.number()),
    strokes: v.optional(v.number()),
    exercise: v.optional(v.string()),
    repetitions: v.optional(v.number()),
    weight: v.optional(v.number()),
    weightUnit: v.optional(v.string()),
    setType: v.optional(v.string()),
    schemaVersion: v.number(),
  })
    .index("by_event_kind_index", ["eventId", "kind", "index"])
    .index("by_user_provider", ["userId", "provider"]),

  workoutZones: defineTable({
    eventId: v.id("events"),
    userId: v.string(),
    provider: providerName,
    kind: v.union(v.literal("heart_rate"), v.literal("power")),
    zone: v.number(),
    lowerBound: v.optional(v.number()),
    upperBound: v.optional(v.number()),
    seconds: v.number(),
    schemaVersion: v.number(),
  })
    .index("by_event_kind_zone", ["eventId", "kind", "zone"])
    .index("by_user_provider", ["userId", "provider"]),

  // Ephemeral inbox for one-time Garmin Activity File callback URLs.
  garminActivityFileJobs: defineTable({
    connectionId: v.id("connections"),
    dataSourceId: v.id("dataSources"),
    eventExternalId: v.string(),
    activityId: v.string(),
    callbackUrl: v.optional(v.string()),
    fileType: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("expired"),
      v.literal("skipped"),
    ),
    attempts: v.number(),
    receivedAt: v.number(),
    expiresAt: v.number(),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    parserVersion: v.string(),
  })
    .index("by_connection_status", ["connectionId", "status"])
    .index("by_activity", ["connectionId", "activityId"])
    .index("by_event_external_id", ["eventExternalId"])
    .index("by_expiry", ["expiresAt"]),

  // -------------------------------------------------------------------------
  // Daily Summaries — precomputed daily aggregates
  // -------------------------------------------------------------------------
  dailySummaries: defineTable({
    userId: v.string(),
    provider: v.optional(providerName),
    dataSourceId: v.optional(v.id("dataSources")),
    source: v.optional(v.string()),
    originalSourceName: v.optional(v.string()),
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
    .index("by_user_provider_category_date", ["userId", "provider", "category", "date"])
    .index("by_user_provider_date", ["userId", "provider", "date"])
    .index("by_user_category_date", ["userId", "category", "date"])
    .index("by_user_date", ["userId", "date"])
    .index("by_data_source", ["dataSourceId"]),

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
  })
    .index("by_state", ["state"])
    .index("by_user_provider", ["userId", "provider"]),

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

  // Durable, bounded inbox for opt-in Polar, WHOOP, and Suunto callbacks.
  providerWebhookReceipts: defineTable({
    provider: liveWebhookProvider,
    idempotencyKey: v.string(),
    eventType: v.string(),
    providerUserId: v.optional(v.string()),
    providerUsername: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    providerTraceId: v.optional(v.string()),
    payloadJson: v.string(),
    payloadDigest: v.string(),
    receivedAt: v.number(),
    expiresAt: v.number(),
    status: providerWebhookReceiptStatus,
    attempt: v.number(),
    connectionId: v.optional(v.id("connections")),
    workflowId: v.optional(v.string()),
    completedAt: v.optional(v.number()),
    resultCode: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  })
    .index("by_provider_idempotency", ["provider", "idempotencyKey"])
    .index("by_status_received", ["status", "receivedAt"])
    .index("by_provider_status_received", ["provider", "status", "receivedAt"])
    .index("by_provider_received", ["provider", "receivedAt"])
    .index("by_received", ["receivedAt"])
    .index("by_expiry", ["expiresAt"])
    .index("by_connection_status", ["connectionId", "status"]),

  // One application-level registration record per live provider.
  providerWebhookRegistrations: defineTable({
    provider: liveWebhookProvider,
    status: providerWebhookRegistrationStatus,
    targetUrl: v.optional(v.string()),
    remoteId: v.optional(v.string()),
    modelVersion: v.optional(v.literal("v2")),
    eventTypes: v.optional(v.array(v.string())),
    webhookSecret: v.optional(v.string()),
    configuredAt: v.optional(v.number()),
    lastVerifiedAt: v.optional(v.number()),
    lastReconciledAt: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_provider", ["provider"]),

  // Optional tenant mapping and durable outgoing event configuration.
  outgoingWebhookConfiguration: defineTable({
    key: v.literal("default"),
    captureEnabled: v.boolean(),
    externalDeliveryEnabled: v.boolean(),
    snapshotPayloadsEnabled: v.boolean(),
    internalCallbackHandle: v.optional(v.string()),
    internalCallbackKind: v.optional(v.union(v.literal("action"), v.literal("mutation"))),
    maxEndpointsPerTenant: v.number(),
    maxEndpointsPerUser: v.number(),
    eventRetentionMs: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  outgoingWebhookUserTenants: defineTable({
    userId: v.string(),
    tenantId: v.string(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_tenant_user", ["tenantId", "userId"]),

  outgoingWebhookEndpoints: defineTable({
    tenantId: v.string(),
    scope: v.union(v.literal("tenant"), v.literal("user")),
    userId: v.optional(v.string()),
    url: v.string(),
    description: v.optional(v.string()),
    eventTypes: v.array(v.string()),
    payloadMode: v.union(v.literal("reference"), v.literal("snapshot")),
    status: outgoingWebhookEndpointStatus,
    encryptedSigningSecret: v.string(),
    signingKeyVersion: v.number(),
    previousEncryptedSigningSecret: v.optional(v.string()),
    previousSecretValidUntil: v.optional(v.number()),
    consecutiveFailureDays: v.number(),
    failureMessageCount: v.number(),
    firstRecentFailureAt: v.optional(v.number()),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    disabledReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenant_status", ["tenantId", "status"])
    .index("by_tenant_user_status", ["tenantId", "userId", "status"])
    .index("by_tenant_time", ["tenantId", "createdAt"])
    .index("by_status", ["status"]),

  outgoingWebhookEvents: defineTable({
    eventPublicId: v.string(),
    tenantId: v.string(),
    userId: v.optional(v.string()),
    provider: v.optional(providerName),
    eventType: v.string(),
    eventVersion: v.number(),
    subjectKind: v.string(),
    subjectId: v.optional(v.string()),
    idempotencyKey: v.string(),
    payloadJson: v.string(),
    referencePayloadJson: v.optional(v.string()),
    occurredAt: v.number(),
    fanoutStatus: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    fanoutCursor: v.optional(v.string()),
    workflowId: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_tenant_time", ["tenantId", "occurredAt"])
    .index("by_tenant_user_time", ["tenantId", "userId", "occurredAt"])
    .index("by_tenant_user_provider_time", ["tenantId", "userId", "provider", "occurredAt"])
    .index("by_tenant_idempotency_key", ["tenantId", "idempotencyKey"])
    .index("by_fanout_status", ["fanoutStatus"])
    .index("by_expiry", ["expiresAt"]),

  outgoingWebhookDeliveries: defineTable({
    eventId: v.id("outgoingWebhookEvents"),
    endpointId: v.id("outgoingWebhookEndpoints"),
    tenantId: v.string(),
    userId: v.optional(v.string()),
    provider: v.optional(providerName),
    payloadJson: v.optional(v.string()),
    status: outgoingWebhookDeliveryStatus,
    attemptCount: v.number(),
    nextAttemptAt: v.optional(v.number()),
    lockedAt: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    lastResponseStatus: v.optional(v.number()),
    lastErrorCode: v.optional(v.string()),
    lastAttemptAt: v.optional(v.number()),
    succeededAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_event_endpoint", ["eventId", "endpointId"])
    .index("by_status_next_attempt", ["status", "nextAttemptAt"])
    .index("by_endpoint_status", ["endpointId", "status"])
    .index("by_endpoint_status_time", ["endpointId", "status", "createdAt"])
    .index("by_tenant_status_time", ["tenantId", "status", "createdAt"])
    .index("by_tenant_endpoint_time", ["tenantId", "endpointId", "createdAt"])
    .index("by_tenant_endpoint_status_time", ["tenantId", "endpointId", "status", "createdAt"])
    .index("by_tenant_time", ["tenantId", "createdAt"]),

  outgoingWebhookAttempts: defineTable({
    deliveryId: v.id("outgoingWebhookDeliveries"),
    endpointId: v.id("outgoingWebhookEndpoints"),
    tenantId: v.string(),
    attempt: v.number(),
    startedAt: v.number(),
    completedAt: v.number(),
    durationMs: v.number(),
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("retryable_failure"),
      v.literal("permanent_failure"),
    ),
    responseStatus: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_delivery_time", ["deliveryId", "startedAt"])
    .index("by_endpoint_time", ["endpointId", "startedAt"])
    .index("by_expiry", ["expiresAt"]),

  outgoingWebhookOperations: defineTable({
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    kind: v.union(v.literal("recover_failed"), v.literal("replay_missing")),
    since: v.number(),
    until: v.optional(v.number()),
    cursor: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    processed: v.number(),
    workflowId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_tenant_time", ["tenantId", "createdAt"])
    .index("by_endpoint_status", ["endpointId", "status"]),

  // -------------------------------------------------------------------------
  // Pending Garmin Push Payloads — short-lived replay queue for OAuth reconnect
  // races where Garmin pushes data before the connection is active again.
  // -------------------------------------------------------------------------
  pendingGarminPushPayloads: defineTable({
    connectionId: v.id("connections"),
    userId: v.string(),
    providerUserId: v.string(),
    garminClientId: v.string(),
    payloadJson: v.string(),
    activityFilesEnabled: v.optional(v.boolean()),
    activityFileAllowedHosts: v.optional(v.array(v.string())),
    activityFileMaxBytes: v.optional(v.number()),
    receivedAt: v.number(),
    expiresAt: v.number(),
    replayedAt: v.optional(v.number()),
    status: v.union(
      v.literal("pending"),
      v.literal("replayed"),
      v.literal("expired"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
  })
    .index("by_connection_status", ["connectionId", "status"])
    .index("by_provider_user_status", ["providerUserId", "status"])
    .index("by_expires", ["expiresAt"]),

  // -------------------------------------------------------------------------
  // Time-Series Policy Rules — default and preset-based storage rules
  // -------------------------------------------------------------------------
  timeSeriesPolicyRules: defineTable({
    policySetKind: v.union(v.literal("default"), v.literal("preset")),
    policySetKey: v.string(), // "__default__" or host-defined preset key
    scopeKey: v.string(),
    provider: v.optional(providerName),
    seriesType: v.optional(v.string()),
    tiers: v.array(
      v.union(
        v.object({
          kind: v.literal("raw"),
          fromAgeMs: v.number(),
          toAgeMs: v.union(v.number(), v.null()),
        }),
        v.object({
          kind: v.literal("rollup"),
          fromAgeMs: v.number(),
          toAgeMs: v.union(v.number(), v.null()),
          bucketMs: v.number(),
          aggregations: v.array(timeSeriesAggregation),
        }),
      ),
    ),
    updatedAt: v.number(),
  })
    .index("by_set", ["policySetKind", "policySetKey"])
    .index("by_set_scope", ["policySetKind", "policySetKey", "provider", "seriesType"]),

  // -------------------------------------------------------------------------
  // Time-Series Policy Assignments — per-user preset selection
  // -------------------------------------------------------------------------
  timeSeriesPolicyAssignments: defineTable({
    userId: v.string(),
    presetKey: v.string(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_preset", ["presetKey"]),

  // -------------------------------------------------------------------------
  // Time-Series Policy Settings — singleton settings for maintenance
  // -------------------------------------------------------------------------
  timeSeriesPolicySettings: defineTable({
    key: v.string(),
    maintenanceEnabled: v.boolean(),
    maintenanceIntervalMs: v.number(),
    scheduledAt: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // -------------------------------------------------------------------------
  // Time-Series Series State — per source/series maintenance cursor
  // -------------------------------------------------------------------------
  timeSeriesSeriesState: defineTable({
    dataSourceId: v.id("dataSources"),
    connectionId: v.optional(v.id("connections")),
    userId: v.string(),
    provider: providerName,
    seriesType: v.string(),
    latestRecordedAt: v.number(),
    lastIngestedAt: v.number(),
    nextMaintenanceAt: v.number(),
    lastMaintenanceAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_source_series", ["dataSourceId", "seriesType"])
    .index("by_next_maintenance", ["nextMaintenanceAt"])
    .index("by_user", ["userId"]),

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

  // -------------------------------------------------------------------------
  // Data Deletion Operations — stable domain state for durable Workflow runs
  // -------------------------------------------------------------------------
  dataDeletionOperations: defineTable({
    userId: v.string(),
    scope: dataDeletionScope,
    provider: v.optional(providerName),
    idempotencyKey: v.string(),
    workflowId: v.optional(v.string()),
    status: dataDeletionStatus,
    currentPhase: v.optional(v.string()),
    requestedDeregistration: v.boolean(),
    deregistrationStatus: providerDeregistrationStatus,
    deletedCounts: v.object({
      connections: v.number(),
      dataSources: v.number(),
      dataPoints: v.number(),
      timeSeriesRollups: v.number(),
      timeSeriesSeriesState: v.number(),
      events: v.number(),
      workoutSegments: v.optional(v.number()),
      workoutZones: v.optional(v.number()),
      garminActivityFileJobs: v.optional(v.number()),
      dailySummaries: v.number(),
      menstrualCycles: v.number(),
      syncJobs: v.number(),
      backfillJobs: v.number(),
      oauthStates: v.number(),
      pendingGarminPushPayloads: v.number(),
      providerWebhookReceipts: v.optional(v.number()),
      outgoingWebhookState: v.optional(v.number()),
      timeSeriesPolicyAssignments: v.number(),
      priorDataDeletionOperations: v.number(),
    }),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_user_created_at", ["userId", "createdAt"])
    .index("by_user_status", ["userId", "status"])
    .index("by_user_idempotency_key", ["userId", "idempotencyKey"]),
});
