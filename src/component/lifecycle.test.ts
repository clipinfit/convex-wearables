import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";

function createWorkflowTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("workflow", workflowTest.schema, workflowTest.modules);
  workpoolTest.register(t, "workflow/workpool");
  return t;
}

const deletionPhases = [
  "pendingGarminPushPayloads",
  "dataPoints",
  "timeSeriesRollups",
  "timeSeriesSeriesState",
  "events",
  "dailySummaries",
  "menstrualCycles",
  "syncJobs",
  "backfillJobs",
  "oauthStates",
  "timeSeriesPolicyAssignments",
  "priorDataDeletionOperations",
  "dataSources",
  "connections",
] as const;

async function runDeletionPrimitives(
  t: ReturnType<typeof createWorkflowTest>,
  operationId: Id<"dataDeletionOperations">,
  workflowId: string,
) {
  await t.mutation(internal.lifecycle.prepareDeletionScope, { operationId });
  for (const phase of deletionPhases) {
    while (true) {
      const result = await t.mutation(internal.lifecycle.deleteScopedBatch, {
        operationId,
        phase,
      });
      if (result.deleted === 0) break;
    }
  }
  const operation = await t.query(api.lifecycle.getDataDeletionOperation, { operationId });
  await t.mutation(internal.lifecycle.handleDataDeletionComplete, {
    workflowId,
    context: { operationId },
    result: {
      kind: "success",
      returnValue: {
        deletedCounts: operation.deletedCounts,
        deregistrationStatus: "not_requested",
      },
    },
  });
}

describe("provider lifecycle and durable deletion", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("deletes one provider in bounded batches and preserves another provider", async () => {
    const t = createWorkflowTest();

    const { garminSourceId, stravaSourceId } = await t.run(async (ctx) => {
      const garminConnectionId = await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "garmin",
        accessToken: "garmin-token",
        status: "active",
      });
      const stravaConnectionId = await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "strava",
        accessToken: "strava-token",
        status: "active",
      });
      const garminSourceId = await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        connectionId: garminConnectionId,
      });
      const stravaSourceId = await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "strava",
        connectionId: stravaConnectionId,
      });

      for (let index = 0; index < 450; index++) {
        await ctx.db.insert("dataPoints", {
          dataSourceId: garminSourceId,
          seriesType: "heart_rate",
          recordedAt: 1_710_000_000_000 + index,
          value: 60 + (index % 40),
        });
      }
      await ctx.db.insert("dataPoints", {
        dataSourceId: stravaSourceId,
        seriesType: "heart_rate",
        recordedAt: 1_710_000_000_000,
        value: 72,
      });
      await ctx.db.insert("events", {
        dataSourceId: garminSourceId,
        userId: "user-1",
        category: "workout",
        startDatetime: 1_710_000_000_000,
      });
      await ctx.db.insert("events", {
        dataSourceId: stravaSourceId,
        userId: "user-1",
        category: "workout",
        startDatetime: 1_710_000_100_000,
      });
      await ctx.db.insert("dailySummaries", {
        userId: "user-1",
        provider: "garmin",
        dataSourceId: garminSourceId,
        date: "2026-07-31",
        category: "activity",
      });
      await ctx.db.insert("dailySummaries", {
        userId: "user-1",
        provider: "strava",
        dataSourceId: stravaSourceId,
        date: "2026-07-31",
        category: "activity",
      });
      return { garminSourceId, stravaSourceId };
    });

    const started = await t.mutation(api.lifecycle.startProviderDataDeletion, {
      userId: "user-1",
      provider: "garmin",
      idempotencyKey: "remove-garmin-1",
    });

    await runDeletionPrimitives(t, started.operationId, started.workflowId);

    const operation = await t.query(api.lifecycle.getDataDeletionOperation, {
      operationId: started.operationId,
    });
    expect(operation.status).toBe("completed");
    expect(operation.deletedCounts.dataPoints).toBe(450);

    await t.run(async (ctx) => {
      expect(await ctx.db.get(garminSourceId)).toBeNull();
      expect(await ctx.db.get(stravaSourceId)).not.toBeNull();

      const garminConnections = await ctx.db
        .query("connections")
        .withIndex("by_user_provider", (index) =>
          index.eq("userId", "user-1").eq("provider", "garmin"),
        )
        .collect();
      const stravaConnections = await ctx.db
        .query("connections")
        .withIndex("by_user_provider", (index) =>
          index.eq("userId", "user-1").eq("provider", "strava"),
        )
        .collect();
      expect(garminConnections).toHaveLength(0);
      expect(stravaConnections).toHaveLength(1);

      const stravaPoints = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (index) => index.eq("dataSourceId", stravaSourceId))
        .collect();
      expect(stravaPoints).toHaveLength(1);
    });
  });

  it("deduplicates starts and fences only the matching provider", async () => {
    const t = createWorkflowTest();
    const garminConnectionId = await t.run(
      async (ctx) =>
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          providerUserId: "garmin-user",
          status: "active",
        }),
    );

    const first = await t.mutation(api.lifecycle.startProviderDataDeletion, {
      userId: "user-1",
      provider: "garmin",
      idempotencyKey: "remove-garmin-1",
    });
    const duplicate = await t.mutation(api.lifecycle.startProviderDataDeletion, {
      userId: "user-1",
      provider: "garmin",
      idempotencyKey: "remove-garmin-1",
    });

    expect(duplicate.operationId).toBe(first.operationId);
    expect(duplicate.workflowId).toBe(first.workflowId);
    expect(duplicate.deduped).toBe(true);

    await expect(
      t.mutation(internal.connections.ensurePushConnection, {
        userId: "user-1",
        provider: "garmin",
      }),
    ).rejects.toThrow("ingestion is blocked");

    await expect(
      t.mutation(internal.garminBackfill.requestGarminBackfill, {
        connectionId: garminConnectionId,
        windowStart: 1_000,
        windowEnd: 2_000,
      }),
    ).rejects.toThrow("ingestion is blocked");

    await expect(
      t.mutation(internal.garminWebhooks.storePendingPayload, {
        connectionId: garminConnectionId,
        userId: "user-1",
        providerUserId: "garmin-user",
        garminClientId: "client",
        payloadJson: "{}",
        receivedAt: 1_000,
        expiresAt: 2_000,
      }),
    ).rejects.toThrow("ingestion is blocked");

    const stravaConnectionId = await t.mutation(internal.connections.ensurePushConnection, {
      userId: "user-1",
      provider: "strava",
    });
    expect(stravaConnectionId).toBeDefined();
  });

  it("deletes all user data but keeps the terminal operation available", async () => {
    const t = createWorkflowTest();
    await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "strava",
        status: "active",
      });
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "strava",
        connectionId,
      });
      await ctx.db.insert("oauthStates", {
        state: "state-1",
        userId: "user-1",
        provider: "strava",
        createdAt: Date.now(),
      });
      await ctx.db.insert("timeSeriesPolicyAssignments", {
        userId: "user-1",
        presetKey: "short",
        updatedAt: Date.now(),
      });
    });

    const started = await t.mutation(api.lifecycle.startUserDataDeletion, {
      userId: "user-1",
      idempotencyKey: "delete-user-1",
    });
    await runDeletionPrimitives(t, started.operationId, started.workflowId);

    const operation = await t.query(api.lifecycle.getDataDeletionOperation, {
      operationId: started.operationId,
    });
    expect(operation.status).toBe("completed");
    expect(operation.deletedCounts.connections).toBe(1);
    expect(operation.deletedCounts.oauthStates).toBe(1);
    expect(operation.deletedCounts.timeSeriesPolicyAssignments).toBe(1);

    await t.run(async (ctx) => {
      const connections = await ctx.db
        .query("connections")
        .withIndex("by_user", (index) => index.eq("userId", "user-1"))
        .collect();
      expect(connections).toHaveLength(0);
      expect(await ctx.db.get(started.operationId)).not.toBeNull();
    });
  });

  it("releases the ingestion fence when an operation is explicitly canceled", async () => {
    const t = createWorkflowTest();
    const started = await t.mutation(api.lifecycle.startProviderDataDeletion, {
      userId: "user-1",
      provider: "garmin",
      idempotencyKey: "cancel-garmin-1",
    });

    await t.mutation(api.lifecycle.cancelDataDeletion, {
      operationId: started.operationId,
    });

    const operation = await t.query(api.lifecycle.getDataDeletionOperation, {
      operationId: started.operationId,
    });
    expect(operation.status).toBe("canceled");

    const connectionId = await t.mutation(internal.connections.ensurePushConnection, {
      userId: "user-1",
      provider: "garmin",
    });
    expect(connectionId).toBeDefined();
  });

  it("summarizes remote deregistration outcomes", async () => {
    const { summarizeDeregistrationResults } = await import("./lifecycle");
    expect(summarizeDeregistrationResults([])).toBe("completed");
    expect(summarizeDeregistrationResults([{ status: "unsupported" }])).toBe("unsupported");
    expect(summarizeDeregistrationResults([{ status: "completed" }, { status: "failed" }])).toBe(
      "partially_completed",
    );
    expect(summarizeDeregistrationResults([{ status: "failed" }])).toBe("failed");
  });
});
