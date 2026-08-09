import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

describe("backfillJobs", () => {
  it("returns the latest backfill job for a connection", async () => {
    const t = convexTest(schema, modules);

    const connectionId = await t.run(async (ctx) => {
      return await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "garmin",
        accessToken: "token",
        status: "active",
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("backfillJobs", {
        connectionId,
        userId: "user-1",
        provider: "garmin",
        dataType: "full",
        status: "failed",
        startedAt: 1,
        completedAt: 2,
      });
      await ctx.db.insert("backfillJobs", {
        connectionId,
        userId: "user-1",
        provider: "garmin",
        dataType: "full",
        status: "running",
        startedAt: 3,
      });
    });

    const job = await t.query(api.backfillJobs.getLatestByConnection, {
      connectionId,
    });

    expect(job?.status).toBe("running");
    expect(job?.startedAt).toBe(3);
  });
});
