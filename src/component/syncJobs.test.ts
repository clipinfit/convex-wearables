import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

describe("syncJobs", () => {
  it("creates a sync job with pending status", async () => {
    const t = convexTest(schema, modules);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("syncJobs", {
        userId: "user-1",
        provider: "strava",
        status: "pending",
        startedAt: Date.now(),
      });
    });

    const job = await t.run(async (ctx) => {
      return await ctx.db.get(id);
    });

    expect(job?.status).toBe("pending");
    expect(job?.userId).toBe("user-1");
    expect(job?.provider).toBe("strava");
  });

  it("transitions status from pending to running to completed", async () => {
    const t = convexTest(schema, modules);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("syncJobs", {
        userId: "user-1",
        status: "pending",
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

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("syncJobs", {
        userId: "user-1",
        provider: "garmin",
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

    await t.run(async (ctx) => {
      await ctx.db.insert("syncJobs", {
        userId: "user-1",
        status: "completed",
        startedAt: 1710000000000,
        completedAt: 1710000060000,
      });
      await ctx.db.insert("syncJobs", {
        userId: "user-1",
        status: "completed",
        startedAt: 1710100000000,
        completedAt: 1710100060000,
      });
      await ctx.db.insert("syncJobs", {
        userId: "user-2",
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

    await t.run(async (ctx) => {
      await ctx.db.insert("syncJobs", {
        userId: "user-1",
        status: "running",
        startedAt: Date.now(),
      });
      await ctx.db.insert("syncJobs", {
        userId: "user-2",
        status: "completed",
        startedAt: Date.now(),
      });
      await ctx.db.insert("syncJobs", {
        userId: "user-3",
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

    await t.run(async (ctx) => {
      await ctx.db.insert("syncJobs", {
        userId: "user-1",
        status: "completed",
        startedAt: Date.now(),
      });
      await ctx.db.insert("syncJobs", {
        userId: "user-1",
        status: "failed",
        startedAt: Date.now(),
        error: "timeout",
      });
      await ctx.db.insert("syncJobs", {
        userId: "user-1",
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
