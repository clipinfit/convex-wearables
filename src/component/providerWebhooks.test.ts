import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { createProviderWebhookSignature, parseNotificationForTest } from "./providerWebhooks";
import schema from "./schema";
import { modules } from "./test.setup";

function createWebhookTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("providerWebhookWorkflow", workflowTest.schema, workflowTest.modules);
  workpoolTest.register(t, "providerWebhookWorkflow/workpool");
  return t;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("providerWebhooks", () => {
  it("creates provider-specific raw-body HMAC signatures", async () => {
    const polar = await createProviderWebhookSignature({
      provider: "polar",
      secret: "polar-secret",
      rawBody: '{"event":"EXERCISE"}',
    });
    const whoop = await createProviderWebhookSignature({
      provider: "whoop",
      secret: "whoop-secret",
      timestamp: "1770000000",
      rawBody: '{"type":"workout.updated"}',
    });

    expect(polar).toMatch(/^[a-f0-9]{64}$/);
    expect(whoop).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(whoop).not.toBe(polar);
  });

  it("validates WHOOP v2, Polar, and bounded Suunto envelopes", () => {
    expect(
      parseNotificationForTest("whoop", {
        type: "workout.updated",
        user_id: 123,
        id: "e6f4d4b2-25f8-43e6-953d-71b8ef6ad7d6",
        trace_id: "trace-1",
      }),
    ).toMatchObject({
      eventType: "workout.updated",
      providerUserId: "123",
      supported: true,
    });
    expect(
      parseNotificationForTest("polar", {
        event: "EXERCISE",
        user_id: 123,
        entity_id: "exercise-1",
        timestamp: "2026-08-02T10:00:00Z",
      }),
    ).toMatchObject({ eventType: "EXERCISE", providerUserId: "123", supported: true });
    expect(() =>
      parseNotificationForTest("suunto", {
        type: "SUUNTO_247_ACTIVITY_CREATED",
        username: "suunto-user",
        samples: Array.from({ length: 5_001 }, () => ({})),
      }),
    ).toThrow("sample limit");
  });

  it("rejects an invalid signature before persisting a receipt", async () => {
    const t = createWebhookTest();
    await t.mutation(api.providerWebhooks.configureProviderWebhook, {
      provider: "suunto",
      webhookSecret: "suunto-secret",
      status: "active",
    });
    const rawBody = JSON.stringify({
      type: "SUUNTO_247_ACTIVITY_CREATED",
      username: "suunto-user",
      samples: [],
    });

    const result = await t.action(api.providerWebhooks.acceptProviderWebhook, {
      provider: "suunto",
      rawBody,
      signature: "invalid",
    });
    const receipts = await t.run(
      async (ctx) => await ctx.db.query("providerWebhookReceipts").collect(),
    );

    expect(result).toMatchObject({
      accepted: false,
      statusCode: 403,
      errorCode: "invalid_signature",
    });
    expect(receipts).toHaveLength(0);
  });

  it("durably accepts and deduplicates an authenticated callback", async () => {
    const t = createWebhookTest();
    await t.mutation(api.providerWebhooks.configureProviderWebhook, {
      provider: "suunto",
      webhookSecret: "suunto-secret",
      status: "active",
    });
    const rawBody = JSON.stringify({
      type: "SUUNTO_247_ACTIVITY_CREATED",
      username: "suunto-user",
      samples: [{ timestamp: "2026-08-02T10:00:00Z", entryData: { HR: 61 } }],
    });
    const signature = await createProviderWebhookSignature({
      provider: "suunto",
      secret: "suunto-secret",
      rawBody,
    });

    const first = await t.action(api.providerWebhooks.acceptProviderWebhook, {
      provider: "suunto",
      rawBody,
      signature,
    });
    const duplicate = await t.action(api.providerWebhooks.acceptProviderWebhook, {
      provider: "suunto",
      rawBody,
      signature,
    });
    const receipts = await t.run(
      async (ctx) => await ctx.db.query("providerWebhookReceipts").collect(),
    );

    expect(first).toMatchObject({ accepted: true, duplicate: false, ping: false });
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true, ping: false });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.workflowId).toBeDefined();
  });

  it("accepts only the exact unsigned Polar creation PING", async () => {
    const t = createWebhookTest();
    const ping = await t.action(api.providerWebhooks.acceptProviderWebhook, {
      provider: "polar",
      rawBody: '{"event":"PING"}',
    });
    const invalid = await t.action(api.providerWebhooks.acceptProviderWebhook, {
      provider: "polar",
      rawBody: '{"event":"PING","user_id":123}',
    });

    expect(ping).toEqual({ accepted: true, duplicate: false, ping: true });
    expect(invalid).toMatchObject({ accepted: false, statusCode: 400, errorCode: "invalid_ping" });
  });

  it("rejects replayed WHOOP signatures outside the timestamp window", async () => {
    const t = createWebhookTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("providerSettings", {
        provider: "whoop",
        isEnabled: true,
        clientId: "whoop-client",
        clientSecret: "whoop-secret",
      });
    });
    const timestamp = "1700000000";
    const rawBody = JSON.stringify({
      type: "sleep.updated",
      user_id: 42,
      id: "018d72f1-57d1-7ec0-a620-723761e7698f",
      trace_id: "trace-stale",
    });
    const signature = await createProviderWebhookSignature({
      provider: "whoop",
      secret: "whoop-secret",
      timestamp,
      rawBody,
    });

    const result = await t.action(api.providerWebhooks.acceptProviderWebhook, {
      provider: "whoop",
      rawBody,
      signature,
      signatureTimestamp: timestamp,
    });
    expect(result).toMatchObject({
      accepted: false,
      statusCode: 403,
      errorCode: "stale_signature",
    });
  });

  it("captures Polar's one-time registration secret without exposing it", async () => {
    const t = createWebhookTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("providerSettings", {
        provider: "polar",
        isEnabled: true,
        clientId: "polar-client",
        clientSecret: "polar-client-secret",
      });
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: "polar-webhook-1",
                signature_secret_key: "one-time-signing-secret",
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await t.action(api.providerWebhooks.createPolarWebhook, {
      targetUrl: "https://example.com/wearables/webhooks/polar",
      eventTypes: ["EXERCISE"],
    });
    const stored = await t.run(
      async (ctx) => await ctx.db.query("providerWebhookRegistrations").first(),
    );
    const safe = await t.query(api.providerWebhooks.getProviderWebhookStatus, {
      provider: "polar",
    });

    expect(stored).toMatchObject({
      status: "active",
      remoteId: "polar-webhook-1",
      webhookSecret: "one-time-signing-secret",
    });
    expect(safe).toMatchObject({ status: "active", secretConfigured: true });
    expect(safe).not.toHaveProperty("webhookSecret");
  });

  it("redacts receipt payloads from public status queries", async () => {
    const t = createWebhookTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("providerWebhookReceipts", {
        provider: "whoop",
        idempotencyKey: "whoop:v2:trace-1",
        eventType: "workout.updated",
        providerUserId: "123",
        resourceId: "workout-1",
        payloadJson: '{"private_health_data":true}',
        payloadDigest: "digest",
        receivedAt: 100,
        expiresAt: 200,
        status: "failed",
        attempt: 4,
      });
    });

    const result = await t.query(api.providerWebhooks.listProviderWebhookReceipts, {
      provider: "whoop",
    });
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).not.toHaveProperty("payloadJson");
  });

  it("deletes only the exact connection-scoped resource and its children", async () => {
    const t = createWebhookTest();
    const ids = await t.run(async (ctx) => {
      const connectionA = await ctx.db.insert("connections", {
        userId: "user-a",
        provider: "whoop",
        providerUserId: "1",
        status: "active",
      });
      const connectionB = await ctx.db.insert("connections", {
        userId: "user-b",
        provider: "whoop",
        providerUserId: "2",
        status: "active",
      });
      const sourceA = await ctx.db.insert("dataSources", {
        userId: "user-a",
        provider: "whoop",
        connectionId: connectionA,
      });
      const sourceB = await ctx.db.insert("dataSources", {
        userId: "user-b",
        provider: "whoop",
        connectionId: connectionB,
      });
      await ctx.db.insert("events", {
        dataSourceId: sourceA,
        userId: "user-a",
        category: "workout",
        startDatetime: 100,
        externalId: "whoop-workout-same-id",
      });
      await ctx.db.insert("events", {
        dataSourceId: sourceB,
        userId: "user-b",
        category: "workout",
        startDatetime: 100,
        externalId: "whoop-workout-same-id",
      });
      return { connectionA };
    });

    expect(
      await t.mutation(internal.providerWebhooks.deleteExactResource, {
        connectionId: ids.connectionA,
        category: "workout",
        externalId: "whoop-workout-same-id",
      }),
    ).toBe(1);
    const events = await t.run(async (ctx) => await ctx.db.query("events").collect());
    expect(events).toHaveLength(1);
    expect(events[0]?.userId).toBe("user-b");
  });

  it("uses a targeted WHOOP v2 fetch and the pull normalizer", async () => {
    const t = createWebhookTest();
    const receiptId = await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("connections", {
        userId: "user-whoop",
        provider: "whoop",
        providerUserId: "99",
        accessToken: "access-token",
        tokenExpiresAt: Date.now() + 60 * 60_000,
        status: "active",
      });
      await ctx.db.insert("providerSettings", {
        provider: "whoop",
        isEnabled: true,
        clientId: "whoop-client",
        clientSecret: "whoop-secret",
      });
      return await ctx.db.insert("providerWebhookReceipts", {
        provider: "whoop",
        idempotencyKey: "whoop:v2:trace-targeted",
        eventType: "workout.updated",
        providerUserId: "99",
        resourceId: "workout-uuid",
        providerTraceId: "trace-targeted",
        payloadJson: "{}",
        payloadDigest: "digest",
        receivedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        status: "pending",
        attempt: 0,
        connectionId,
      });
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.prod.whoop.com/v2/activity/workout/workout-uuid");
      return new Response(
        JSON.stringify({
          id: "workout-uuid",
          start: "2026-08-02T10:00:00Z",
          end: "2026-08-02T11:00:00Z",
          sport_name: "Running",
          score_state: "SCORED",
          score: { average_heart_rate: 145, max_heart_rate: 178 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.providerWebhooks.processReceipt, { receiptId });
    const events = await t.run(async (ctx) => await ctx.db.query("events").collect());

    expect(result).toEqual({ code: "upserted", records: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      userId: "user-whoop",
      category: "workout",
      type: "running",
      externalId: "whoop-workout-workout-uuid",
      heartRateAvg: 145,
    });
  });
});
