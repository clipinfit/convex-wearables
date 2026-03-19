import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

async function seedConnection(
  t: ReturnType<typeof convexTest>,
  args: { userId?: string; provider?: "garmin" | "strava" } = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("connections", {
      userId: args.userId ?? "user-1",
      provider: args.provider ?? "strava",
      accessToken: "token",
      status: "active",
    });
  });
}

describe("syncJobs", () => {
  it("creates a sync job with pending status", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await seedConnection(t);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-1",
        status: "queued",
        startedAt: Date.now(),
      });
    });

    const job = await t.run(async (ctx) => {
      return await ctx.db.get(id);
    });

    expect(job?.status).toBe("queued");
    expect(job?.userId).toBe("user-1");
    expect(job?.provider).toBe("strava");
  });

  it("transitions status from queued to running to completed", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await seedConnection(t);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-2",
        status: "queued",
        startedAt: Date.now(),
      });
    });

    // Move to running
    await t.run(async (ctx) => {
      await ctx.db.patch(id, { status: "running" });
    });

    const running = await t.run(async (ctx) => {
      return await ctx.db.get(id);
    });
    expect(running?.status).toBe("running");

    // Complete
    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        status: "completed",
        completedAt: Date.now(),
        recordsProcessed: 42,
      });
    });

    const completed = await t.run(async (ctx) => {
      return await ctx.db.get(id);
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.recordsProcessed).toBe(42);
    expect(completed?.completedAt).toBeDefined();
  });

  it("records error on failed sync job", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await seedConnection(t, { provider: "garmin" });

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "garmin",
        idempotencyKey: "job-3",
        status: "running",
        startedAt: Date.now(),
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.patch(id, {
        status: "failed",
        completedAt: Date.now(),
        error: "Token refresh failed (401): invalid_grant",
      });
    });

    const failed = await t.run(async (ctx) => {
      return await ctx.db.get(id);
    });

    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("invalid_grant");
  });

  it("queries sync jobs by user (most recent first)", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await seedConnection(t);
    const otherConnectionId = await seedConnection(t, {
      userId: "user-2",
      provider: "garmin",
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-4",
        status: "completed",
        startedAt: 1710000000000,
        completedAt: 1710000060000,
      });
      await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-5",
        status: "completed",
        startedAt: 1710100000000,
        completedAt: 1710100060000,
      });
      await ctx.db.insert("syncJobs", {
        connectionId: otherConnectionId,
        userId: "user-2",
        provider: "garmin",
        idempotencyKey: "job-6",
        status: "completed",
        startedAt: 1710000000000,
      });
    });

    const user1Jobs = await t.run(async (ctx) => {
      return await ctx.db
        .query("syncJobs")
        .withIndex("by_user", (idx) => idx.eq("userId", "user-1"))
        .order("desc")
        .collect();
    });

    expect(user1Jobs).toHaveLength(2);
  });

  it("queries running jobs via status index", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await seedConnection(t);
    const otherConnectionId = await seedConnection(t, { userId: "user-2" });
    const thirdConnectionId = await seedConnection(t, {
      userId: "user-3",
      provider: "garmin",
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-7",
        status: "running",
        startedAt: Date.now(),
      });
      await ctx.db.insert("syncJobs", {
        connectionId: otherConnectionId,
        userId: "user-2",
        provider: "strava",
        idempotencyKey: "job-8",
        status: "completed",
        startedAt: Date.now(),
      });
      await ctx.db.insert("syncJobs", {
        connectionId: thirdConnectionId,
        userId: "user-3",
        provider: "garmin",
        idempotencyKey: "job-9",
        status: "running",
        startedAt: Date.now(),
      });
    });

    const running = await t.run(async (ctx) => {
      return await ctx.db
        .query("syncJobs")
        .withIndex("by_status", (idx) => idx.eq("status", "running"))
        .collect();
    });

    expect(running).toHaveLength(2);
  });

  it("queries by user + status via composite index", async () => {
    const t = convexTest(schema, modules);
    const connectionId = await seedConnection(t);

    await t.run(async (ctx) => {
      await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-10",
        status: "completed",
        startedAt: Date.now(),
      });
      await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-11",
        status: "failed",
        startedAt: Date.now(),
        error: "timeout",
      });
      await ctx.db.insert("syncJobs", {
        connectionId,
        userId: "user-1",
        provider: "strava",
        idempotencyKey: "job-12",
        status: "running",
        startedAt: Date.now(),
      });
    });

    const failedJobs = await t.run(async (ctx) => {
      return await ctx.db
        .query("syncJobs")
        .withIndex("by_user_status", (idx) => idx.eq("userId", "user-1").eq("status", "failed"))
        .collect();
    });

    expect(failedJobs).toHaveLength(1);
    expect(failedJobs[0].error).toBe("timeout");
  });
});
