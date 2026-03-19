import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalMutation } from "./_generated/server";
import { backfillSignal } from "./backfillJobs";
import { triggerBackfill } from "./providers/garmin";
import { durableWorkflow } from "./workflowManager";

const DEFAULT_LOOKBACK_DAYS = 30;
const BACKFILL_TIMEOUT_MS = 5 * 60 * 1000;
export const GARMIN_BACKFILL_TYPES = [
  "activities",
  "activityDetails",
  "dailies",
  "epochs",
  "sleeps",
  "bodyComps",
  "hrv",
  "stressDetails",
  "respiration",
  "pulseOx",
  "bloodPressures",
  "userMetrics",
  "skinTemp",
  "healthSnapshot",
  "moveiq",
  "mct",
] as const;

type GarminBackfillType = (typeof GARMIN_BACKFILL_TYPES)[number];

export const requestGarminBackfill = internalMutation({
  args: {
    connectionId: v.id("connections"),
    windowStart: v.number(),
    windowEnd: v.number(),
  },
  returns: v.object({
    backfillJobId: v.id("backfillJobs"),
    workflowId: v.string(),
    deduped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      throw new Error(`Connection ${args.connectionId} not found`);
    }
    if (connection.provider !== "garmin") {
      throw new Error("Garmin backfill is only supported for Garmin connections");
    }

    const existing = await ctx.db
      .query("backfillJobs")
      .withIndex("by_connection", (idx) => idx.eq("connectionId", args.connectionId))
      .order("desc")
      .first();

    if (existing && (existing.status === "queued" || existing.status === "running")) {
      return {
        backfillJobId: existing._id,
        workflowId: existing.workflowId ?? "",
        deduped: true,
      };
    }

    const backfillJobId = await ctx.db.insert("backfillJobs", {
      connectionId: connection._id,
      userId: connection.userId,
      provider: "garmin",
      dataType: "full",
      status: "queued",
      startedAt: Date.now(),
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      completedDataTypes: [],
      currentAttempt: 0,
    });

    const workflowId = await durableWorkflow.start(
      ctx,
      internal.garminBackfill.runGarminBackfill,
      { backfillJobId },
      {
        startAsync: true,
        onComplete: internal.garminBackfill.handleGarminBackfillComplete,
        context: { backfillJobId },
      },
    );

    await ctx.db.patch(backfillJobId, { workflowId });

    return {
      backfillJobId,
      workflowId,
      deduped: false,
    };
  },
});

export const triggerGarminBackfillType = internalAction({
  args: {
    backfillJobId: v.id("backfillJobs"),
    dataType: v.string(),
  },
  handler: async (ctx, args) => {
    if (!GARMIN_BACKFILL_TYPES.includes(args.dataType as GarminBackfillType)) {
      throw new Error(`Unsupported Garmin backfill type: ${args.dataType}`);
    }

    const backfillJob = await ctx.runQuery(internal.backfillJobs.getById, {
      backfillJobId: args.backfillJobId,
    });
    if (!backfillJob) {
      throw new Error(`Backfill job ${args.backfillJobId} not found`);
    }

    const connection = await ctx.runQuery(internal.connections.getById, {
      connectionId: backfillJob.connectionId,
    });
    if (!connection) {
      throw new Error(`Connection ${backfillJob.connectionId} not found`);
    }

    const credentials = await ctx.runQuery(internal.providerSettings.getCredentials, {
      provider: "garmin",
    });
    if (!credentials) {
      throw new Error("Missing stored Garmin credentials");
    }

    try {
      const accessToken = await ctx.runAction(internal.oauthActions.ensureValidToken, {
        connectionId: connection._id,
        provider: "garmin",
        accessToken: connection.accessToken ?? "",
        refreshToken: connection.refreshToken,
        tokenExpiresAt: connection.tokenExpiresAt,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        subscriptionKey: credentials.subscriptionKey,
      });

      await triggerBackfill(
        accessToken,
        args.dataType,
        Math.floor((backfillJob.windowStart ?? Date.now()) / 1000),
        Math.floor((backfillJob.windowEnd ?? Date.now()) / 1000),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("Authorization expired") ||
        message.includes("Token expired") ||
        message.includes("Token refresh failed")
      ) {
        await ctx.runMutation(internal.connections.updateStatus, {
          connectionId: connection._id,
          status: "expired",
        });
      }
      throw error;
    }
  },
});

export const runGarminBackfill = durableWorkflow.define({
  args: {
    backfillJobId: v.id("backfillJobs"),
  },
  returns: v.object({
    completedTypes: v.array(v.string()),
  }),
  handler: async (step, args): Promise<{ completedTypes: string[] }> => {
    const job = await step.runQuery(internal.backfillJobs.getById, {
      backfillJobId: args.backfillJobId,
    });
    if (!job) {
      throw new Error(`Backfill job ${args.backfillJobId} not found`);
    }

    await step.runMutation(internal.backfillJobs.updateStatus, {
      backfillJobId: args.backfillJobId,
      status: "running",
      workflowId: job.workflowId,
      lastHeartbeatAt: Date.now(),
    });

    const completed = new Set<string>(job.completedDataTypes ?? []);

    for (const dataType of GARMIN_BACKFILL_TYPES) {
      if (completed.has(dataType)) {
        continue;
      }

      let completedType = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const eventId = await step.runMutation(internal.backfillJobs.beginAwaitingType, {
          backfillJobId: args.backfillJobId,
          workflowId: step.workflowId,
          dataType,
          attempt,
        });

        await step.runAction(internal.garminBackfill.triggerGarminBackfillType, {
          backfillJobId: args.backfillJobId,
          dataType,
        });

        await step.runMutation(internal.backfillJobs.scheduleTimeout, {
          backfillJobId: args.backfillJobId,
          eventId,
          dataType,
          delayMs: BACKFILL_TIMEOUT_MS,
        });

        const signal = await step.awaitEvent({
          id: eventId as never,
          validator: backfillSignal,
        });

        if (signal.kind === "webhook") {
          await step.runMutation(internal.backfillJobs.markTypeCompleted, {
            backfillJobId: args.backfillJobId,
            dataType,
          });
          completed.add(dataType);
          completedType = true;
          break;
        }
      }

      if (!completedType) {
        throw new Error(`Garmin backfill timed out for ${dataType}`);
      }

      await step.runMutation(internal.backfillJobs.updateStatus, {
        backfillJobId: args.backfillJobId,
        status: "running",
        completedDataTypes: Array.from(completed),
        lastHeartbeatAt: Date.now(),
      });
    }

    return {
      completedTypes: Array.from(completed),
    };
  },
});

export const handleGarminBackfillComplete = internalMutation({
  args: {
    workflowId: v.string(),
    result: v.any(),
    context: v.object({
      backfillJobId: v.id("backfillJobs"),
    }),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.context.backfillJobId);
    if (!job) return;

    if (args.result.kind === "success") {
      const returnValue = (args.result.returnValue ?? {}) as { completedTypes?: string[] };
      await ctx.db.patch(job._id, {
        status: "completed",
        completedAt: Date.now(),
        workflowId: args.workflowId,
        completedDataTypes: returnValue.completedTypes ?? job.completedDataTypes ?? [],
        lastHeartbeatAt: Date.now(),
      });
      return;
    }

    if (args.result.kind === "canceled") {
      await ctx.db.patch(job._id, {
        status: "canceled",
        completedAt: Date.now(),
        workflowId: args.workflowId,
        lastHeartbeatAt: Date.now(),
      });
      return;
    }

    await ctx.db.patch(job._id, {
      status: "failed",
      completedAt: Date.now(),
      error: args.result.error,
      workflowId: args.workflowId,
      lastHeartbeatAt: Date.now(),
    });
  },
});

export const startGarminBackfill = action({
  args: {
    connectionId: v.id("connections"),
    lookbackDays: v.optional(v.number()),
    clientId: v.optional(v.string()),
    clientSecret: v.optional(v.string()),
  },
  returns: v.object({
    backfillJobId: v.string(),
    workflowId: v.string(),
    deduped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.runQuery(internal.connections.getById, {
      connectionId: args.connectionId,
    });
    if (!connection) {
      throw new Error(`Connection ${args.connectionId} not found`);
    }
    if (connection.provider !== "garmin") {
      throw new Error("Garmin backfill is only supported for Garmin connections");
    }

    if ((args.clientId && !args.clientSecret) || (!args.clientId && args.clientSecret)) {
      throw new Error("clientId and clientSecret must be provided together");
    }

    if (args.clientId && args.clientSecret) {
      await ctx.runMutation(internal.providerSettings.upsertCredentials, {
        provider: "garmin",
        clientId: args.clientId,
        clientSecret: args.clientSecret,
      });
    }

    const now = Date.now();
    const lookbackMs = (args.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000;

    const result = await ctx.runMutation(internal.garminBackfill.requestGarminBackfill, {
      connectionId: args.connectionId,
      windowStart: now - lookbackMs,
      windowEnd: now,
    });

    return {
      backfillJobId: String(result.backfillJobId),
      workflowId: result.workflowId,
      deduped: result.deduped,
    };
  },
});
