/**
 * Garmin webhook processing.
 *
 * Garmin pushes data to registered webhook endpoints. This module
 * provides actions that process the push payloads and store the data.
 */

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, action } from "./_generated/server";
import {
  type GarminPushPayload,
  normalizeActivity,
  normalizeBloodPressureDataPoints,
  normalizeBodyCompositionDataPoints,
  normalizeBodyCompositionSummary,
  normalizeDaily,
  normalizeDailyRecoverySummary,
  normalizeEpochDataPoints,
  normalizeHealthSnapshotDataPoints,
  normalizeHrvDataPoints,
  normalizeHrvSummary,
  normalizeMCT,
  normalizeMoveIQ,
  normalizePulseOxDataPoints,
  normalizePulseOxSummary,
  normalizeRespirationDataPoints,
  normalizeSkinTemperatureDataPoints,
  normalizeSleep,
  normalizeSleepSummary,
  normalizeStressDataPoints,
  normalizeUserMetricsDataPoints,
} from "./providers/garmin";

const DATA_POINT_BATCH_SIZE = 100;

/**
 * Process a Garmin push webhook payload.
 *
 * Handles activities, sleep, dailies, and extended wellness feeds.
 */
export const processPushPayload = action({
  args: {
    payload: v.any(),
    garminClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const payload = args.payload as GarminPushPayload;
    const signalBuckets = new Map<string, Set<string>>();

    await processActivityEntries(ctx, payload.activities, "activities", signalBuckets);
    await processActivityEntries(ctx, payload.activityDetails, "activityDetails", signalBuckets);

    if (payload.sleeps?.length) {
      for (const sleep of payload.sleeps) {
        const connection = await resolveConnection(ctx, sleep.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        const event = normalizeSleep(sleep);
        await ctx.runMutation(internal.events.storeEvent, {
          dataSourceId,
          userId: connection.userId,
          category: event.category,
          type: event.type,
          sourceName: event.sourceName,
          durationSeconds: event.durationSeconds,
          startDatetime: event.startDatetime,
          endDatetime: event.endDatetime,
          externalId: event.externalId,
          heartRateAvg: event.heartRateAvg,
          heartRateMin: event.heartRateMin,
          sleepTotalDurationMinutes: event.sleepTotalDurationMinutes,
          sleepDeepMinutes: event.sleepDeepMinutes,
          sleepLightMinutes: event.sleepLightMinutes,
          sleepRemMinutes: event.sleepRemMinutes,
          sleepAwakeMinutes: event.sleepAwakeMinutes,
          sleepEfficiencyScore: event.sleepEfficiencyScore,
          sleepStages: event.sleepStages,
        });

        await upsertSummary(ctx, connection.userId, normalizeSleepSummary(sleep));

        const supplementalPoints = [];
        if (sleep.avgOxygenSaturation != null) {
          supplementalPoints.push({
            seriesType: "oxygen_saturation",
            recordedAt: sleep.startTimeInSeconds * 1000,
            value: sleep.avgOxygenSaturation,
            externalId: `${sleep.summaryId}:sleep_spo2`,
          });
          await upsertSummary(ctx, connection.userId, {
            date: isoDateFromTimestamp(sleep.startTimeInSeconds * 1000),
            category: "recovery",
            spo2Avg: sleep.avgOxygenSaturation,
          });
        }
        if (sleep.respirationAvg != null) {
          supplementalPoints.push({
            seriesType: "respiratory_rate",
            recordedAt: sleep.startTimeInSeconds * 1000,
            value: sleep.respirationAvg,
            externalId: `${sleep.summaryId}:sleep_respiration`,
          });
        }
        await storeNormalizedDataPoints(ctx, dataSourceId, supplementalPoints);

        addSignal(signalBuckets, "sleeps", connection._id);
      }
    }

    if (payload.dailies?.length) {
      for (const daily of payload.dailies) {
        const connection = await resolveConnection(ctx, daily.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        const normalized = normalizeDaily(daily);

        await upsertSummary(ctx, connection.userId, {
          date: normalized.date,
          category: "activity",
          totalSteps: normalized.totalSteps,
          totalCalories: normalized.totalCalories,
          activeCalories: normalized.activeCalories,
          totalDistance: normalized.totalDistance,
          floorsClimbed: normalized.floorsClimbed,
          avgHeartRate: normalized.avgHeartRate,
          maxHeartRate: normalized.maxHeartRate,
          minHeartRate: normalized.minHeartRate,
          activeMinutes: normalized.activeMinutes,
        });

        await upsertSummary(ctx, connection.userId, normalizeDailyRecoverySummary(daily));

        const points = [];
        if (normalized.restingHeartRate != null) {
          points.push({
            seriesType: "resting_heart_rate",
            recordedAt: daily.startTimeInSeconds * 1000,
            value: normalized.restingHeartRate,
            externalId: daily.summaryId ? `${daily.summaryId}:resting_heart_rate` : undefined,
          });
        }
        if (normalized.heartRateSamples?.length) {
          points.push(
            ...normalized.heartRateSamples.map((sample) => ({
              seriesType: "heart_rate",
              recordedAt: sample.timestamp,
              value: sample.value,
            })),
          );
        }
        await storeNormalizedDataPoints(ctx, dataSourceId, points);

        addSignal(signalBuckets, "dailies", connection._id);
      }
    }

    if (payload.epochs?.length) {
      for (const epoch of payload.epochs) {
        const connection = await resolveConnection(ctx, epoch.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(ctx, dataSourceId, normalizeEpochDataPoints(epoch));
        addSignal(signalBuckets, "epochs", connection._id);
      }
    }

    if (payload.bodyComps?.length) {
      for (const bodyComp of payload.bodyComps) {
        const connection = await resolveConnection(ctx, bodyComp.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(
          ctx,
          dataSourceId,
          normalizeBodyCompositionDataPoints(bodyComp),
        );
        await upsertSummary(ctx, connection.userId, normalizeBodyCompositionSummary(bodyComp));

        addSignal(signalBuckets, "bodyComps", connection._id);
      }
    }

    if (payload.hrv?.length) {
      for (const hrv of payload.hrv) {
        const connection = await resolveConnection(ctx, hrv.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(ctx, dataSourceId, normalizeHrvDataPoints(hrv));
        await upsertSummary(ctx, connection.userId, normalizeHrvSummary(hrv));

        addSignal(signalBuckets, "hrv", connection._id);
      }
    }

    if (payload.stressDetails?.length) {
      for (const stress of payload.stressDetails) {
        const connection = await resolveConnection(ctx, stress.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(ctx, dataSourceId, normalizeStressDataPoints(stress));
        addSignal(signalBuckets, "stressDetails", connection._id);
      }
    }

    if (payload.respiration?.length) {
      for (const respiration of payload.respiration) {
        const connection = await resolveConnection(ctx, respiration.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(
          ctx,
          dataSourceId,
          normalizeRespirationDataPoints(respiration),
        );
        addSignal(signalBuckets, "respiration", connection._id);
      }
    }

    if (payload.pulseOx?.length) {
      for (const pulseOx of payload.pulseOx) {
        const connection = await resolveConnection(ctx, pulseOx.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(ctx, dataSourceId, normalizePulseOxDataPoints(pulseOx));
        await upsertSummary(ctx, connection.userId, normalizePulseOxSummary(pulseOx));

        addSignal(signalBuckets, "pulseOx", connection._id);
      }
    }

    if (payload.bloodPressures?.length) {
      for (const bloodPressure of payload.bloodPressures) {
        const connection = await resolveConnection(ctx, bloodPressure.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(
          ctx,
          dataSourceId,
          normalizeBloodPressureDataPoints(bloodPressure),
        );
        addSignal(signalBuckets, "bloodPressures", connection._id);
      }
    }

    if (payload.userMetrics?.length) {
      for (const userMetrics of payload.userMetrics) {
        const connection = await resolveConnection(ctx, userMetrics.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(
          ctx,
          dataSourceId,
          normalizeUserMetricsDataPoints(userMetrics),
        );
        addSignal(signalBuckets, "userMetrics", connection._id);
      }
    }

    if (payload.skinTemp?.length) {
      for (const skinTemp of payload.skinTemp) {
        const connection = await resolveConnection(ctx, skinTemp.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(
          ctx,
          dataSourceId,
          normalizeSkinTemperatureDataPoints(skinTemp),
        );
        addSignal(signalBuckets, "skinTemp", connection._id);
      }
    }

    if (payload.healthSnapshot?.length) {
      for (const snapshot of payload.healthSnapshot) {
        const connection = await resolveConnection(ctx, snapshot.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        await storeNormalizedDataPoints(
          ctx,
          dataSourceId,
          normalizeHealthSnapshotDataPoints(snapshot),
        );
        addSignal(signalBuckets, "healthSnapshot", connection._id);
      }
    }

    if (payload.moveiq?.length) {
      for (const moveIQ of payload.moveiq) {
        const connection = await resolveConnection(ctx, moveIQ.userId);
        if (!connection) continue;

        const dataSourceId = await resolveDataSource(ctx, connection);
        if (!dataSourceId) continue;

        const event = normalizeMoveIQ(moveIQ);
        await ctx.runMutation(internal.events.storeEvent, {
          dataSourceId,
          userId: connection.userId,
          category: event.category,
          type: event.type,
          sourceName: event.sourceName,
          durationSeconds: event.durationSeconds,
          startDatetime: event.startDatetime,
          endDatetime: event.endDatetime,
          externalId: event.externalId,
        });

        addSignal(signalBuckets, "moveiq", connection._id);
      }
    }

    const menstrualCycleTracking =
      payload.menstrualCycleTracking && payload.menstrualCycleTracking.length > 0
        ? payload.menstrualCycleTracking
        : payload.mct;
    if (menstrualCycleTracking?.length) {
      for (const mct of menstrualCycleTracking) {
        const connection = await resolveConnection(ctx, mct.userId);
        if (!connection) continue;

        const normalized = normalizeMCT(mct);
        await ctx.runMutation(internal.menstrualCycles.upsert, {
          userId: connection.userId,
          provider: "garmin" as const,
          externalId: normalized.externalId,
          periodStartDate: normalized.periodStartDate,
          dayInCycle: normalized.dayInCycle,
          cycleLength: normalized.cycleLength,
          predictedCycleLength: normalized.predictedCycleLength,
          periodLength: normalized.periodLength,
          currentPhase: normalized.currentPhase,
          currentPhaseType: normalized.currentPhaseType,
          lengthOfCurrentPhase: normalized.lengthOfCurrentPhase,
          daysUntilNextPhase: normalized.daysUntilNextPhase,
          isPredictedCycle: normalized.isPredictedCycle,
          fertileWindowStart: normalized.fertileWindowStart,
          lengthOfFertileWindow: normalized.lengthOfFertileWindow,
          lastUpdatedAt: normalized.lastUpdatedAt,
          isPregnant: normalized.isPregnant,
          pregnancyDueDate: normalized.pregnancyDueDate,
          pregnancyOriginalDueDate: normalized.pregnancyOriginalDueDate,
          pregnancyCycleStartDate: normalized.pregnancyCycleStartDate,
          pregnancyTitle: normalized.pregnancyTitle,
          numberOfBabies: normalized.numberOfBabies,
        });

        addSignal(signalBuckets, "mct", connection._id);
      }
    }

    if (payload.userPermissionsChange?.length) {
      for (const change of payload.userPermissionsChange) {
        const connection = await resolveConnection(ctx, change.userId);
        if (!connection) continue;

        await ctx.runMutation(internal.connections.updateScope, {
          connectionId: connection._id,
          scope:
            change.permissions.length > 0 ? [...change.permissions].sort().join(" ") : undefined,
        });
      }
    }

    if (payload.deregistrations?.length) {
      for (const dereg of payload.deregistrations) {
        const connection = await resolveConnection(ctx, dereg.userId);
        if (!connection) continue;

        await ctx.runMutation(internal.connections.updateStatus, {
          connectionId: connection._id,
          status: "revoked",
        });
      }
    }

    for (const [dataType, connectionIds] of signalBuckets) {
      const itemCount = getPayloadItemCount(payload, dataType);
      for (const connectionId of connectionIds) {
        await ctx.runMutation(internal.backfillJobs.signalWebhookData, {
          connectionId: connectionId as Id<"connections">,
          dataType,
          itemCount,
        });
      }
    }
  },
});

async function processActivityEntries(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  activities: GarminPushPayload["activities"] | GarminPushPayload["activityDetails"],
  dataType: "activities" | "activityDetails",
  signalBuckets: Map<string, Set<string>>,
) {
  if (!activities?.length) {
    return;
  }

  for (const activity of activities) {
    const connection = await resolveConnection(ctx, activity.userId);
    if (!connection) continue;

    const dataSourceId = await resolveDataSource(ctx, connection, activity.deviceName);
    if (!dataSourceId) continue;

    const event = normalizeActivity(activity);
    await ctx.runMutation(internal.events.storeEvent, {
      dataSourceId,
      userId: connection.userId,
      category: event.category,
      type: event.type,
      sourceName: event.sourceName,
      durationSeconds: event.durationSeconds,
      startDatetime: event.startDatetime,
      endDatetime: event.endDatetime,
      externalId: event.externalId,
      heartRateAvg: event.heartRateAvg,
      heartRateMax: event.heartRateMax,
      energyBurned: event.energyBurned,
      distance: event.distance,
      stepsCount: event.stepsCount,
      averageSpeed: event.averageSpeed,
      maxSpeed: event.maxSpeed,
      averageWatts: event.averageWatts,
      maxWatts: event.maxWatts,
      totalElevationGain: event.totalElevationGain,
      movingTimeSeconds: event.movingTimeSeconds,
    });

    addSignal(signalBuckets, dataType, connection._id);
  }
}

async function storeNormalizedDataPoints(
  ctx: Pick<ActionCtx, "runMutation">,
  dataSourceId: Id<"dataSources">,
  points: Array<{
    seriesType: string;
    recordedAt: number;
    value: number;
    externalId?: string;
  }>,
) {
  if (points.length === 0) {
    return;
  }

  const grouped = new Map<
    string,
    Array<{ recordedAt: number; value: number; externalId?: string }>
  >();

  for (const point of points) {
    const existing = grouped.get(point.seriesType) ?? [];
    existing.push({
      recordedAt: point.recordedAt,
      value: point.value,
      externalId: point.externalId,
    });
    grouped.set(point.seriesType, existing);
  }

  for (const [seriesType, seriesPoints] of grouped) {
    for (let i = 0; i < seriesPoints.length; i += DATA_POINT_BATCH_SIZE) {
      await ctx.runMutation(internal.dataPoints.storeBatch, {
        dataSourceId,
        seriesType,
        points: seriesPoints.slice(i, i + DATA_POINT_BATCH_SIZE),
      });
    }
  }
}

async function upsertSummary<T extends { date: string; category: string }>(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: string,
  summary: T | null,
) {
  if (!summary) {
    return;
  }

  const { date, category, ...metrics } = summary;
  if (typeof date !== "string" || typeof category !== "string") {
    return;
  }

  const hasMetrics = Object.values(metrics).some((value) => value !== undefined && value !== null);
  if (!hasMetrics) {
    return;
  }

  await ctx.runMutation(internal.summaries.upsert, {
    userId,
    date,
    category,
    ...metrics,
  });
}

function addSignal(
  signalBuckets: Map<string, Set<string>>,
  dataType: string,
  connectionId: string,
) {
  const entries = signalBuckets.get(dataType) ?? new Set<string>();
  entries.add(connectionId);
  signalBuckets.set(dataType, entries);
}

function getPayloadItemCount(payload: GarminPushPayload, dataType: string): number | undefined {
  switch (dataType) {
    case "activities":
      return payload.activities?.length;
    case "activityDetails":
      return payload.activityDetails?.length;
    case "sleeps":
      return payload.sleeps?.length;
    case "dailies":
      return payload.dailies?.length;
    case "epochs":
      return payload.epochs?.length;
    case "bodyComps":
      return payload.bodyComps?.length;
    case "hrv":
      return payload.hrv?.length;
    case "stressDetails":
      return payload.stressDetails?.length;
    case "respiration":
      return payload.respiration?.length;
    case "pulseOx":
      return payload.pulseOx?.length;
    case "bloodPressures":
      return payload.bloodPressures?.length;
    case "userMetrics":
      return payload.userMetrics?.length;
    case "skinTemp":
      return payload.skinTemp?.length;
    case "healthSnapshot":
      return payload.healthSnapshot?.length;
    case "moveiq":
      return payload.moveiq?.length;
    case "mct":
      return payload.menstrualCycleTracking && payload.menstrualCycleTracking.length > 0
        ? payload.menstrualCycleTracking.length
        : payload.mct?.length;
    default:
      return undefined;
  }
}

function isoDateFromTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString().split("T")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Garmin userId to the internal userId via the connections table.
 */
async function resolveConnection(
  ctx: Pick<ActionCtx, "runQuery">,
  garminUserId: string,
): Promise<Doc<"connections"> | null> {
  const conn = await ctx.runQuery(internal.connections.getByProviderUser, {
    provider: "garmin",
    providerUserId: garminUserId,
  });
  return (conn as Doc<"connections"> | null) ?? null;
}

/**
 * Resolve a Garmin userId to a dataSource ID, creating one if needed.
 */
async function resolveDataSource(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  connection: Doc<"connections">,
  deviceName?: string,
): Promise<Id<"dataSources"> | null> {
  return await ctx.runMutation(api.dataSources.getOrCreate, {
    userId: connection.userId,
    provider: "garmin",
    connectionId: connection._id,
    deviceModel: deviceName,
    source: "garmin",
  });
}
