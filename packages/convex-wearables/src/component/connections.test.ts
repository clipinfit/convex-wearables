import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

describe("connections", () => {
  describe("createConnection", () => {
    it("creates a new active connection", async () => {
      const t = convexTest(schema, modules);

      const id = await t.run(async (ctx) => {
        return await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          accessToken: "access-token-123",
          refreshToken: "refresh-token-456",
          tokenExpiresAt: Date.now() + 3600000,
          providerUserId: "garmin-user-789",
          status: "active",
        });
      });

      expect(id).toBeDefined();

      const conn = await t.run(async (ctx) => {
        return await ctx.db.get(id);
      });
      expect(conn).toMatchObject({
        provider: "garmin",
        status: "active",
        providerUserId: "garmin-user-789",
      });
    });

    it("re-activates existing connection with patch", async () => {
      const t = convexTest(schema, modules);

      const id = await t.run(async (ctx) => {
        return await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "strava",
          accessToken: "old-token",
          status: "active",
        });
      });

      // Disconnect
      await t.run(async (ctx) => {
        await ctx.db.patch(id, {
          status: "inactive",
          accessToken: undefined,
          refreshToken: undefined,
        });
      });

      // Re-activate with new tokens
      await t.run(async (ctx) => {
        await ctx.db.patch(id, {
          status: "active",
          accessToken: "new-token",
          refreshToken: "new-refresh",
        });
      });

      const conn = await t.run(async (ctx) => {
        return await ctx.db.get(id);
      });
      expect(conn?.status).toBe("active");
      expect(conn?.accessToken).toBe("new-token");
    });
  });

  describe("queries", () => {
    it("finds connections by user via index", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          accessToken: "t1",
          status: "active",
        });
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "strava",
          accessToken: "t2",
          status: "active",
        });
        await ctx.db.insert("connections", {
          userId: "user-2",
          provider: "whoop",
          accessToken: "t3",
          status: "active",
        });
      });

      const user1 = await t.run(async (ctx) => {
        return await ctx.db
          .query("connections")
          .withIndex("by_user", (idx) => idx.eq("userId", "user-1"))
          .collect();
      });

      expect(user1).toHaveLength(2);
      const providers = user1.map((c) => c.provider);
      expect(providers).toContain("garmin");
      expect(providers).toContain("strava");
    });

    it("finds connection by user + provider via index", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          accessToken: "t1",
          status: "active",
        });
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "strava",
          accessToken: "t2",
          status: "active",
        });
      });

      const conn = await t.run(async (ctx) => {
        return await ctx.db
          .query("connections")
          .withIndex("by_user_provider", (idx) =>
            idx.eq("userId", "user-1").eq("provider", "garmin"),
          )
          .first();
      });

      expect(conn).not.toBeNull();
      expect(conn?.provider).toBe("garmin");
    });

    it("redacts token fields from getByUserProvider", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          providerUserId: "garmin-user",
          accessToken: "secret-access",
          refreshToken: "secret-refresh",
          tokenExpiresAt: Date.now() + 60_000,
          status: "active",
        });
      });

      const conn = await t.query(api.connections.getByUserProvider, {
        userId: "user-1",
        provider: "garmin",
      });

      expect(conn).toMatchObject({
        userId: "user-1",
        provider: "garmin",
        providerUserId: "garmin-user",
        status: "active",
      });
      expect(conn).not.toHaveProperty("accessToken");
      expect(conn).not.toHaveProperty("refreshToken");
      expect(conn).not.toHaveProperty("tokenExpiresAt");
    });

    it("finds active connections via index", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          accessToken: "t1",
          status: "active",
        });
        await ctx.db.insert("connections", {
          userId: "user-2",
          provider: "strava",
          accessToken: "t2",
          status: "inactive",
        });
      });

      const active = await t.run(async (ctx) => {
        return await ctx.db
          .query("connections")
          .withIndex("by_status", (idx) => idx.eq("status", "active"))
          .collect();
      });

      expect(active).toHaveLength(1);
      expect(active[0].userId).toBe("user-1");
    });

    it("returns the latest sync job per provider in getSyncStatus", async () => {
      const t = convexTest(schema, modules);

      await t.run(async (ctx) => {
        const garminConnectionId = await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "garmin",
          accessToken: "garmin-token",
          status: "active",
          lastSyncedAt: 1_000,
        });
        const stravaConnectionId = await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "strava",
          accessToken: "strava-token",
          status: "active",
          lastSyncedAt: 2_000,
        });

        await ctx.db.insert("syncJobs", {
          connectionId: garminConnectionId,
          userId: "user-1",
          provider: "garmin",
          idempotencyKey: "garmin-1",
          status: "completed",
          startedAt: 100,
        });
        await ctx.db.insert("syncJobs", {
          connectionId: stravaConnectionId,
          userId: "user-1",
          provider: "strava",
          idempotencyKey: "strava-1",
          status: "failed",
          startedAt: 200,
          error: "rate limited",
        });
      });

      const statuses = await t.query(api.connections.getSyncStatus, {
        userId: "user-1",
      });

      expect(statuses).toEqual(
        expect.arrayContaining([
          {
            provider: "garmin",
            connectionStatus: "active",
            lastSyncedAt: 1_000,
            syncJobStatus: "completed",
            syncJobError: null,
          },
          {
            provider: "strava",
            connectionStatus: "active",
            lastSyncedAt: 2_000,
            syncJobStatus: "failed",
            syncJobError: "rate limited",
          },
        ]),
      );
    });
  });

  describe("disconnect", () => {
    it("sets status to inactive and clears tokens", async () => {
      const t = convexTest(schema, modules);

      const id = await t.run(async (ctx) => {
        return await ctx.db.insert("connections", {
          userId: "user-1",
          provider: "whoop",
          accessToken: "secret",
          refreshToken: "secret-r",
          status: "active",
        });
      });

      await t.run(async (ctx) => {
        await ctx.db.patch(id, {
          status: "inactive",
          accessToken: undefined,
          refreshToken: undefined,
          tokenExpiresAt: undefined,
        });
      });

      const conn = await t.run(async (ctx) => {
        return await ctx.db.get(id);
      });
      expect(conn?.status).toBe("inactive");
      expect(conn?.accessToken).toBeUndefined();
      expect(conn?.refreshToken).toBeUndefined();
    });
  });
});
