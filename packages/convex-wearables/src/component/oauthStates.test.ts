import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

describe("oauthStates", () => {
  it("stores and retrieves a state by token", async () => {
    const t = convexTest(schema, modules);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("oauthStates", {
        state: "random-state-abc",
        userId: "user-1",
        provider: "strava",
        createdAt: Date.now(),
      });
    });

    const found = await t.run(async (ctx) => {
      return await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (idx) => idx.eq("state", "random-state-abc"))
        .first();
    });

    expect(found).not.toBeNull();
    expect(found?._id).toBe(id);
    expect(found?.userId).toBe("user-1");
    expect(found?.provider).toBe("strava");
  });

  it("stores PKCE code verifier and redirect URI", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("oauthStates", {
        state: "pkce-state-123",
        userId: "user-1",
        provider: "suunto",
        codeVerifier: "verifier-abc-xyz",
        redirectUri: "https://example.com/callback",
        createdAt: Date.now(),
      });
    });

    const found = await t.run(async (ctx) => {
      return await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (idx) => idx.eq("state", "pkce-state-123"))
        .first();
    });

    expect(found?.codeVerifier).toBe("verifier-abc-xyz");
    expect(found?.redirectUri).toBe("https://example.com/callback");
  });

  it("consumes state (read and delete)", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("oauthStates", {
        state: "consume-me",
        userId: "user-1",
        provider: "strava",
        createdAt: Date.now(),
      });
    });

    // Consume: read and delete
    const consumed = await t.run(async (ctx) => {
      const record = await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (idx) => idx.eq("state", "consume-me"))
        .first();
      if (record) {
        await ctx.db.delete(record._id);
      }
      return record;
    });

    expect(consumed).not.toBeNull();
    expect(consumed?.provider).toBe("strava");

    // Verify it's gone
    const afterConsume = await t.run(async (ctx) => {
      return await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (idx) => idx.eq("state", "consume-me"))
        .first();
    });

    expect(afterConsume).toBeNull();
  });

  it("returns null when consuming non-existent state", async () => {
    const t = convexTest(schema, modules);

    const result = await t.run(async (ctx) => {
      return await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (idx) => idx.eq("state", "does-not-exist"))
        .first();
    });

    expect(result).toBeNull();
  });

  it("handles multiple states for same user (different providers)", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("oauthStates", {
        state: "state-strava",
        userId: "user-1",
        provider: "strava",
        createdAt: Date.now(),
      });
      await ctx.db.insert("oauthStates", {
        state: "state-garmin",
        userId: "user-1",
        provider: "garmin",
        createdAt: Date.now(),
      });
    });

    const strava = await t.run(async (ctx) => {
      return await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (idx) => idx.eq("state", "state-strava"))
        .first();
    });

    const garmin = await t.run(async (ctx) => {
      return await ctx.db
        .query("oauthStates")
        .withIndex("by_state", (idx) => idx.eq("state", "state-garmin"))
        .first();
    });

    expect(strava?.provider).toBe("strava");
    expect(garmin?.provider).toBe("garmin");
  });

  it("cleanup deletes state by ID", async () => {
    const t = convexTest(schema, modules);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("oauthStates", {
        state: "to-cleanup",
        userId: "user-1",
        provider: "whoop",
        createdAt: Date.now(),
      });
    });

    // Simulate scheduled cleanup
    await t.run(async (ctx) => {
      const record = await ctx.db.get(id);
      if (record) {
        await ctx.db.delete(id);
      }
    });

    const after = await t.run(async (ctx) => {
      return await ctx.db.get(id);
    });

    expect(after).toBeNull();
  });
});
