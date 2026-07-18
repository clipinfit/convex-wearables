import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

function createTest() {
  return convexTest(schema, modules);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth connection lifecycle", () => {
  it("revokes a connection when the provider definitively rejects its refresh token", async () => {
    const t = createTest();
    const connectionId = await t.run(async (ctx) =>
      ctx.db.insert("connections", {
        userId: "user-1",
        provider: "strava",
        accessToken: "expired-access-token",
        refreshToken: "dead-refresh-token",
        tokenExpiresAt: 1,
        status: "active",
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 401 })),
    );

    await expect(
      t.action(internal.oauthActions.ensureValidToken, {
        connectionId,
        provider: "strava",
        accessToken: "expired-access-token",
        refreshToken: "dead-refresh-token",
        tokenExpiresAt: 1,
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).rejects.toThrow("Token refresh failed (401)");

    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.status).toBe("revoked");
  });

  it("keeps a connection active after a transient refresh failure", async () => {
    const t = createTest();
    const connectionId = await t.run(async (ctx) =>
      ctx.db.insert("connections", {
        userId: "user-1",
        provider: "strava",
        accessToken: "expired-access-token",
        refreshToken: "refresh-token",
        tokenExpiresAt: 1,
        status: "active",
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider unavailable", { status: 503 })),
    );

    await expect(
      t.action(internal.oauthActions.ensureValidToken, {
        connectionId,
        provider: "strava",
        accessToken: "expired-access-token",
        refreshToken: "refresh-token",
        tokenExpiresAt: 1,
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).rejects.toThrow("Token refresh failed (503)");

    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.status).toBe("active");
  });

  it("marks an expired connection without a refresh token as expired", async () => {
    const t = createTest();
    const connectionId = await t.run(async (ctx) =>
      ctx.db.insert("connections", {
        userId: "user-1",
        provider: "strava",
        accessToken: "expired-access-token",
        tokenExpiresAt: 1,
        status: "active",
      }),
    );

    await expect(
      t.action(internal.oauthActions.ensureValidToken, {
        connectionId,
        provider: "strava",
        accessToken: "expired-access-token",
        tokenExpiresAt: 1,
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).rejects.toThrow("no refresh token available");

    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection?.status).toBe("expired");
  });
});
