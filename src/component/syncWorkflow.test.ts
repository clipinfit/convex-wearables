import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

function createWorkflowTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("workflow", workflowTest.schema, workflowTest.modules);
  workpoolTest.register(t, "workflow/workpool");
  return t;
}

describe("syncWorkflow", () => {
  it("reuses an active sync job with the same idempotency key", async () => {
    const t = createWorkflowTest();

    const connectionId = await t.run(async (ctx) => {
      return await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "garmin",
        accessToken: "garmin-token",
        tokenExpiresAt: Date.now() + 60_000,
        status: "active",
      });
    });

    const existingJobId = await t.run(async (ctx) => {
      return await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "garmin",
        idempotencyKey: `${connectionId}::manual::1000::2000`,
        status: "queued",
        startedAt: Date.now(),
      });
    });

    const result = await t.mutation(internal.syncWorkflow.requestConnectionSync, {
      connectionId,
      mode: "manual",
      triggerSource: "test",
      windowStart: 1000,
      windowEnd: 2000,
    });

    expect(String(result.syncJobId)).toBe(String(existingJobId));
    expect(result.deduped).toBe(true);
  });

  it("enqueues a garmin sync on the durable workflow", async () => {
    const t = createWorkflowTest();

    const connectionId = await t.run(async (ctx) => {
      return await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "garmin",
        accessToken: "garmin-token",
        tokenExpiresAt: Date.now() + 60 * 60 * 1000,
        status: "active",
      });
    });

    await t.mutation(internal.providerSettings.upsertCredentials, {
      provider: "garmin",
      clientId: "garmin-client",
      clientSecret: "garmin-secret",
    });

    const result = await t.action(api.syncWorkflow.syncConnection, {
      connectionId,
      provider: "garmin",
      clientId: "garmin-client",
      clientSecret: "garmin-secret",
    });

    const job = await t.query(internal.syncJobs.getById, {
      jobId: result.syncJobId as never,
    });

    expect(job?.status).toBe("queued");
    expect(job?.workflowId).toBeDefined();
    expect(result.deduped).toBe(false);
  });
});
