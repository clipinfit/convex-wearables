import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { modules } from "./test.setup";

describe("dataSources", () => {
  it("creates a new data source", async () => {
    const t = convexTest(schema, modules);

    const id = await t.run(async (ctx) => {
      return await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "strava",
        source: "strava",
      });
    });

    const ds = await t.run(async (ctx) => {
      return await ctx.db.get(id);
    });

    expect(ds?.userId).toBe("user-1");
    expect(ds?.provider).toBe("strava");
  });

  it("finds data sources by user via index", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "strava",
        source: "strava",
      });
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        deviceModel: "Forerunner 965",
        source: "garmin-connect",
      });
      await ctx.db.insert("dataSources", {
        userId: "user-2",
        provider: "whoop",
        source: "whoop",
      });
    });

    const user1Sources = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1"))
        .collect();
    });

    expect(user1Sources).toHaveLength(2);
  });

  it("finds data sources by user + provider via index", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "strava",
        source: "strava",
      });
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        source: "garmin-connect",
      });
    });

    const stravaSources = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1").eq("provider", "strava"))
        .collect();
    });

    expect(stravaSources).toHaveLength(1);
    expect(stravaSources[0].provider).toBe("strava");
  });

  it("upserts by user/provider/device/source (getOrCreate pattern)", async () => {
    const t = convexTest(schema, modules);

    // Create initial data source
    const id1 = await t.run(async (ctx) => {
      return await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        deviceModel: "Forerunner 965",
        source: "garmin-connect",
        softwareVersion: "1.0",
      });
    });

    // Simulate getOrCreate — same user/provider/device/source should find existing
    const found = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider_device", (idx) =>
          idx
            .eq("userId", "user-1")
            .eq("provider", "garmin")
            .eq("deviceModel", "Forerunner 965")
            .eq("source", "garmin-connect"),
        )
        .first();
    });

    expect(found?._id).toBe(id1);

    // Update the software version (simulating upsert update)
    await t.run(async (ctx) => {
      if (found) {
        await ctx.db.patch(found._id, { softwareVersion: "2.0" });
      }
    });

    const updated = await t.run(async (ctx) => {
      return await ctx.db.get(id1);
    });

    expect(updated?.softwareVersion).toBe("2.0");
  });

  it("creates separate entries for different devices", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        deviceModel: "Forerunner 965",
        source: "garmin-connect",
      });
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        deviceModel: "Venu 3",
        source: "garmin-connect",
      });
    });

    const sources = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1").eq("provider", "garmin"))
        .collect();
    });

    expect(sources).toHaveLength(2);
    const devices = sources.map((s) => s.deviceModel);
    expect(devices).toContain("Forerunner 965");
    expect(devices).toContain("Venu 3");
  });

  it("finds data sources by connectionId", async () => {
    const t = convexTest(schema, modules);

    const connId = await t.run(async (ctx) => {
      return await ctx.db.insert("connections", {
        userId: "user-1",
        provider: "strava",
        accessToken: "tok",
        status: "active",
      });
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "strava",
        connectionId: connId,
        source: "strava",
      });
      // Unrelated data source
      await ctx.db.insert("dataSources", {
        userId: "user-2",
        provider: "garmin",
        source: "garmin",
      });
    });

    const byConn = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_connection", (idx) => idx.eq("connectionId", connId))
        .collect();
    });

    expect(byConn).toHaveLength(1);
    expect(byConn[0].provider).toBe("strava");
  });

  it("deletes all data sources for a user", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "strava",
        source: "strava",
      });
      await ctx.db.insert("dataSources", {
        userId: "user-1",
        provider: "garmin",
        source: "garmin",
      });
      await ctx.db.insert("dataSources", {
        userId: "user-2",
        provider: "whoop",
        source: "whoop",
      });
    });

    // Delete user-1 sources
    await t.run(async (ctx) => {
      const sources = await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1"))
        .collect();
      for (const s of sources) {
        await ctx.db.delete(s._id);
      }
    });

    const user1 = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-1"))
        .collect();
    });
    expect(user1).toHaveLength(0);

    // user-2 unaffected
    const user2 = await t.run(async (ctx) => {
      return await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (idx) => idx.eq("userId", "user-2"))
        .collect();
    });
    expect(user2).toHaveLength(1);
  });
});
