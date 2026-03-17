/**
 * Garmin webhook processing.
 *
 * Garmin pushes data to registered webhook endpoints. This module
 * provides actions that process the push payloads and store the data.
 */

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";
import {
  type GarminPushPayload,
  normalizeActivity,
  normalizeDaily,
  normalizeMCT,
  normalizeSleep,
} from "./providers/garmin";

/**
 * Process a Garmin push webhook payload.
 *
 * Handles activities, sleep, dailies — stores normalized data
 * in the component's tables.
 */
export const processPushPayload = internalAction({
  args: {
    payload: v.any(),
    garminClientId: v.string(),
  },
  handler: async (ctx, args) => {
    const payload = args.payload as GarminPushPayload;

    // Process activities
    if (payload.activities?.length) {
      for (const activity of payload.activities) {
        const garminUserId = activity.userId;

        // Find the connection for this Garmin user
        const dataSourceId = await resolveDataSource(ctx, garminUserId, activity.deviceName);
        if (!dataSourceId) continue;

        const event = normalizeActivity(activity);
        const userId = await resolveUserId(ctx, garminUserId);
        if (!userId) continue;

        await ctx.runMutation(internal.events.storeEvent, {
          dataSourceId,
          userId,
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
      }
    }

    // Process sleep
    if (payload.sleeps?.length) {
      for (const sleep of payload.sleeps) {
        const dataSourceId = await resolveDataSource(ctx, sleep.userId);
        if (!dataSourceId) continue;

        const event = normalizeSleep(sleep);
        const userId = await resolveUserId(ctx, sleep.userId);
        if (!userId) continue;

        await ctx.runMutation(internal.events.storeEvent, {
          dataSourceId,
          userId,
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
      }
    }

    // Process dailies → daily summaries
    if (payload.dailies?.length) {
      for (const daily of payload.dailies) {
        const userId = await resolveUserId(ctx, daily.userId);
        if (!userId) continue;

        const normalized = normalizeDaily(daily);

        await ctx.runMutation(internal.summaries.upsert, {
          userId,
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

        // Store resting heart rate as time-series data point
        if (normalized.restingHeartRate != null) {
          const dataSourceId = await resolveDataSource(ctx, daily.userId);
          if (dataSourceId) {
            await ctx.runMutation(internal.dataPoints.storeDataPoint, {
              dataSourceId,
              seriesType: "resting_heart_rate",
              recordedAt: daily.startTimeInSeconds * 1000,
              value: normalized.restingHeartRate,
            });
          }
        }

        // Store HR samples as time-series
        if (normalized.heartRateSamples?.length) {
          const dataSourceId = await resolveDataSource(ctx, daily.userId);
          if (dataSourceId) {
            // Store in batches
            const BATCH = 100;
            for (let i = 0; i < normalized.heartRateSamples.length; i += BATCH) {
              const batch = normalized.heartRateSamples.slice(i, i + BATCH);
              await ctx.runMutation(internal.dataPoints.storeBatch, {
                dataSourceId,
                seriesType: "heart_rate",
                points: batch.map((s) => ({
                  recordedAt: s.timestamp,
                  value: s.value,
                })),
              });
            }
          }
        }
      }
    }

    // Process menstrual cycle tracking (Women's Health)
    if (payload.menstrualCycleTracking?.length) {
      for (const mct of payload.menstrualCycleTracking) {
        const userId = await resolveUserId(ctx, mct.userId);
        if (!userId) continue;

        const normalized = normalizeMCT(mct);

        await ctx.runMutation(internal.menstrualCycles.upsert, {
          userId,
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
      }
    }

    // Handle deregistrations
    if (payload.deregistrations?.length) {
      for (const dereg of payload.deregistrations) {
        // Find connection by providerUserId and disconnect
        const connections = await ctx.runQuery(internal.connections.getAllActive, {});
        const conn = (connections as Doc<"connections">[]).find(
          (c) => c.provider === "garmin" && c.providerUserId === dereg.userId,
        );
        if (conn) {
          await ctx.runMutation(internal.connections.updateStatus, {
            connectionId: conn._id,
            status: "revoked",
          });
        }
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a Garmin userId to the internal userId via the connections table.
 */
async function resolveUserId(
  ctx: Pick<ActionCtx, "runQuery">,
  garminUserId: string,
): Promise<string | null> {
  const connections = await ctx.runQuery(internal.connections.getAllActive, {});
  const conn = (connections as Doc<"connections">[]).find(
    (c) => c.provider === "garmin" && c.providerUserId === garminUserId,
  );
  return conn?.userId ?? null;
}

/**
 * Resolve a Garmin userId to a dataSource ID, creating one if needed.
 */
async function resolveDataSource(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  garminUserId: string,
  deviceName?: string,
): Promise<Id<"dataSources"> | null> {
  const userId = await resolveUserId(ctx, garminUserId);
  if (!userId) return null;

  return await ctx.runMutation(api.dataSources.getOrCreate, {
    userId,
    provider: "garmin",
    deviceModel: deviceName,
    source: "garmin",
  });
}
