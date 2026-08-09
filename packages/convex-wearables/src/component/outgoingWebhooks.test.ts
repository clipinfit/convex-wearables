import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import {
  createOutgoingWebhookSignatureForTest,
  decryptWebhookSecretForTest,
  encryptWebhookSecretForTest,
} from "./outgoingWebhookActions";
import { canonicalJson } from "./outgoingWebhooks";
import schema from "./schema";
import { modules } from "./test.setup";

function createTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("outgoingWebhookWorkflow", workflowTest.schema, workflowTest.modules);
  workpoolTest.register(t, "outgoingWebhookWorkflow/workpool");
  return t;
}

const testKey = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  vi.useFakeTimers();
  process.env.CONVEX_WEARABLES_WEBHOOK_ENCRYPTION_KEY = testKey;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.CONVEX_WEARABLES_WEBHOOK_ENCRYPTION_KEY;
  delete process.env.CONVEX_WEARABLES_WEBHOOK_PREVIOUS_ENCRYPTION_KEY;
});

async function enable(t: ReturnType<typeof createTest>) {
  await t.mutation(api.outgoingWebhooks.configureOutgoingWebhooks, {
    captureEnabled: true,
    externalDeliveryEnabled: true,
  });
  await t.mutation(api.outgoingWebhooks.setWebhookUserTenant, {
    userId: "user-1",
    tenantId: "tenant-1",
  });
}

describe("durable outgoing webhooks", () => {
  it("keeps normal ingestion unchanged while capture is disabled", async () => {
    const t = createTest();
    const sourceId = await t.run(
      async (ctx) => await ctx.db.insert("dataSources", { userId: "user-1", provider: "garmin" }),
    );
    await t.mutation(internal.events.storeEvent, {
      dataSourceId: sourceId,
      userId: "user-1",
      category: "workout",
      startDatetime: 100,
      externalId: "workout-1",
    });
    expect(await t.run(async (ctx) => await ctx.db.query("events").collect())).toHaveLength(1);
    expect(
      await t.run(async (ctx) => await ctx.db.query("outgoingWebhookEvents").collect()),
    ).toHaveLength(0);
  });

  it("captures a canonical transactional event and deduplicates source replay", async () => {
    const t = createTest();
    await enable(t);
    await t.mutation(api.outgoingWebhooks.configureOutgoingWebhooks, {
      captureEnabled: true,
      externalDeliveryEnabled: true,
      internalCallbackHandle: "callback-handle",
      internalCallbackKind: "mutation",
    });
    const sourceId = await t.run(
      async (ctx) => await ctx.db.insert("dataSources", { userId: "user-1", provider: "garmin" }),
    );
    const payload = {
      dataSourceId: sourceId,
      userId: "user-1",
      category: "workout" as const,
      startDatetime: 100,
      endDatetime: 200,
      externalId: "workout-1",
    };
    await t.mutation(internal.events.storeEvent, payload);
    await t.mutation(internal.events.storeEvent, payload);
    const rows = await t.run(async (ctx) => await ctx.db.query("outgoingWebhookEvents").collect());
    expect(rows).toHaveLength(1);
    const envelope = JSON.parse(rows[0]!.payloadJson);
    expect(envelope).toMatchObject({
      type: "workout.upserted",
      version: 1,
      tenantId: "tenant-1",
      userId: "user-1",
      provider: "garmin",
      subject: { kind: "workout" },
    });
    expect(rows[0]!.payloadJson).toBe(canonicalJson(envelope));
    await expect(
      t.query(internal.outgoingWebhooks.getEventForCallback, { eventId: rows[0]!._id }),
    ).resolves.toMatchObject({ handle: "callback-handle", kind: "mutation" });
  });

  it("expands event groups at save time and never exposes encrypted secrets", async () => {
    const t = createTest();
    await enable(t);
    const endpointId = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "user",
      userId: "user-1",
      url: "https://hooks.example.com/path?token=private",
      eventTypes: ["workout.*"],
      payloadMode: "reference",
      encryptedSigningSecret: "encrypted-value",
    });
    const endpoint = await t.query(api.outgoingWebhooks.getWebhookEndpoint, {
      tenantId: "tenant-1",
      endpointId,
    });
    expect(endpoint.eventTypes).toEqual([
      "workout.deleted",
      "workout.enriched",
      "workout.upserted",
    ]);
    expect(endpoint.url).toBe("https://hooks.example.com/path");
    expect(endpoint.hasQueryParameters).toBe(true);
    expect(endpoint).not.toHaveProperty("encryptedSigningSecret");
  });

  it("enforces tenant and exact user scope during fan-out", async () => {
    const t = createTest();
    await enable(t);
    await t.mutation(api.outgoingWebhooks.configureOutgoingWebhooks, {
      captureEnabled: true,
      externalDeliveryEnabled: true,
      snapshotPayloadsEnabled: true,
    });
    await t.mutation(api.outgoingWebhooks.setWebhookUserTenant, {
      userId: "user-2",
      tenantId: "tenant-1",
    });
    const endpointA = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "user",
      userId: "user-1",
      url: "https://a.example.com/",
      eventTypes: ["workout.upserted"],
      payloadMode: "reference",
      encryptedSigningSecret: "a",
    });
    const endpointB = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "user",
      userId: "user-2",
      url: "https://b.example.com/",
      eventTypes: ["workout.upserted"],
      payloadMode: "reference",
      encryptedSigningSecret: "b",
    });
    const endpointSnapshot = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "user",
      userId: "user-1",
      url: "https://snapshot.example.com/",
      eventTypes: ["workout.upserted"],
      payloadMode: "snapshot",
      encryptedSigningSecret: "snapshot",
    });
    await t.mutation(internal.outgoingWebhooks.activateEndpoint, { endpointId: endpointA });
    await t.mutation(internal.outgoingWebhooks.activateEndpoint, { endpointId: endpointB });
    await t.mutation(internal.outgoingWebhooks.activateEndpoint, { endpointId: endpointSnapshot });
    const eventId = await t.run(
      async (ctx) =>
        await ctx.db.insert("outgoingWebhookEvents", {
          eventPublicId: "event-1",
          tenantId: "tenant-1",
          userId: "user-1",
          provider: "garmin",
          eventType: "workout.upserted",
          eventVersion: 1,
          subjectKind: "workout",
          idempotencyKey: "event-1",
          payloadJson: '{"data":{"metric":42}}',
          referencePayloadJson: '{"data":{"eventId":"event-1"}}',
          occurredAt: 1,
          fanoutStatus: "pending",
          expiresAt: Date.now() + 60_000,
        }),
    );
    expect(await t.mutation(internal.outgoingWebhooks.fanOutEvent, { eventId })).toBe(2);
    const deliveries = await t.run(
      async (ctx) => await ctx.db.query("outgoingWebhookDeliveries").collect(),
    );
    expect(deliveries).toHaveLength(2);
    expect(deliveries.find((row) => row.endpointId === endpointA)?.payloadJson).toBe(
      '{"data":{"eventId":"event-1"}}',
    );
    expect(deliveries.find((row) => row.endpointId === endpointSnapshot)?.payloadJson).toBe(
      '{"data":{"metric":42}}',
    );
    const history = await t.query(api.outgoingWebhooks.listWebhookDeliveries, {
      tenantId: "tenant-1",
    });
    expect(history.deliveries[0]).not.toHaveProperty("payloadJson");
  });

  it("persists retry state and permanently disables HTTP 410 endpoints", async () => {
    const t = createTest();
    await enable(t);
    const endpointId = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "tenant",
      url: "https://hooks.example.com/",
      eventTypes: ["sync.failed"],
      payloadMode: "reference",
      encryptedSigningSecret: "secret",
    });
    await t.mutation(internal.outgoingWebhooks.activateEndpoint, { endpointId });
    const { deliveryId } = await t.run(async (ctx) => {
      const eventId = await ctx.db.insert("outgoingWebhookEvents", {
        eventPublicId: "event-retry",
        tenantId: "tenant-1",
        eventType: "sync.failed",
        eventVersion: 1,
        subjectKind: "sync",
        idempotencyKey: "event-retry",
        payloadJson: "{}",
        occurredAt: 1,
        fanoutStatus: "completed",
        expiresAt: Date.now() + 60_000,
      });
      const deliveryId = await ctx.db.insert("outgoingWebhookDeliveries", {
        eventId,
        endpointId,
        tenantId: "tenant-1",
        status: "delivering",
        attemptCount: 0,
        lockedAt: Date.now(),
        leaseToken: "lease-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { deliveryId };
    });
    await t.mutation(internal.outgoingWebhooks.finishDeliveryAttempt, {
      deliveryId,
      leaseToken: "lease-1",
      startedAt: Date.now() - 10,
      durationMs: 10,
      success: false,
      permanent: false,
      responseStatus: 500,
      errorCode: "http_500",
    });
    let delivery = await t.run(async (ctx) => await ctx.db.get(deliveryId));
    expect(delivery).toMatchObject({ status: "retry_scheduled", attemptCount: 1 });
    await t.run(
      async (ctx) =>
        await ctx.db.patch(deliveryId, {
          status: "delivering",
          lockedAt: Date.now(),
          leaseToken: "lease-2",
        }),
    );
    await t.mutation(internal.outgoingWebhooks.finishDeliveryAttempt, {
      deliveryId,
      leaseToken: "lease-2",
      startedAt: Date.now() - 10,
      durationMs: 10,
      success: false,
      permanent: true,
      responseStatus: 410,
      errorCode: "receiver_gone",
    });
    delivery = await t.run(async (ctx) => await ctx.db.get(deliveryId));
    expect(delivery?.status).toBe("failed");
    expect(
      (await t.query(internal.outgoingWebhooks.getEndpointInternal, { endpointId }))?.status,
    ).toBe("disabled");
  });

  it("re-enqueues an abandoned lease and rejects a late worker result", async () => {
    const t = createTest();
    await enable(t);
    const endpointId = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "tenant",
      url: "https://hooks.example.com/",
      eventTypes: ["sync.failed"],
      payloadMode: "reference",
      encryptedSigningSecret: "secret",
    });
    await t.mutation(internal.outgoingWebhooks.activateEndpoint, { endpointId });
    const deliveryId = await t.run(async (ctx) => {
      const now = Date.now();
      const eventId = await ctx.db.insert("outgoingWebhookEvents", {
        eventPublicId: "abandoned-event",
        tenantId: "tenant-1",
        eventType: "sync.failed",
        eventVersion: 1,
        subjectKind: "sync",
        idempotencyKey: "abandoned-event",
        payloadJson: "{}",
        occurredAt: now,
        fanoutStatus: "completed",
        expiresAt: now + 60 * 60_000,
      });
      return await ctx.db.insert("outgoingWebhookDeliveries", {
        eventId,
        endpointId,
        tenantId: "tenant-1",
        payloadJson: "{}",
        status: "pending",
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    });
    const leaseToken = await t.mutation(internal.outgoingWebhooks.claimDelivery, { deliveryId });
    expect(leaseToken).toBeTypeOf("string");
    if (!leaseToken) throw new Error("Expected the delivery to be claimed");

    vi.setSystemTime(Date.now() + 2 * 60_000 + 1);
    await expect(
      t.mutation(internal.outgoingWebhooks.recoverAbandonedDelivery, {
        deliveryId,
        leaseToken,
      }),
    ).resolves.toBe(true);
    expect(await t.run(async (ctx) => await ctx.db.get(deliveryId))).toMatchObject({
      status: "retry_scheduled",
      attemptCount: 1,
      lastErrorCode: "worker_interrupted",
    });
    await expect(
      t.query(internal.outgoingWebhooks.getDeliveryBundle, { deliveryId, leaseToken }),
    ).resolves.toBeNull();

    await t.mutation(internal.outgoingWebhooks.finishDeliveryAttempt, {
      deliveryId,
      leaseToken,
      startedAt: Date.now() - 10,
      durationMs: 10,
      success: true,
      permanent: false,
      responseStatus: 200,
    });
    expect((await t.run(async (ctx) => await ctx.db.get(deliveryId)))?.status).toBe(
      "retry_scheduled",
    );
    expect(
      await t.run(async (ctx) => await ctx.db.query("outgoingWebhookAttempts").collect()),
    ).toHaveLength(1);
  });

  it("encrypts secrets at rest and signs exact bytes", () => {
    const encrypted = encryptWebhookSecretForTest("whsec_test");
    expect(encrypted).not.toContain("whsec_test");
    expect(decryptWebhookSecretForTest(encrypted)).toBe("whsec_test");
    process.env.CONVEX_WEARABLES_WEBHOOK_PREVIOUS_ENCRYPTION_KEY = testKey;
    process.env.CONVEX_WEARABLES_WEBHOOK_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(decryptWebhookSecretForTest(encrypted)).toBe("whsec_test");
    const signature = createOutgoingWebhookSignatureForTest("secret", "event-1", 123, '{"a":1}');
    expect(signature).not.toBe(
      createOutgoingWebhookSignatureForTest("secret", "event-1", 123, '{"a":2}'),
    );
  });

  it("rejects unsafe endpoint URLs before network delivery", async () => {
    const t = createTest();
    await expect(
      t.action(api.outgoingWebhookActions.testValidateWebhookUrl, {
        url: "http://127.0.0.1/hook",
      }),
    ).rejects.toThrow("HTTPS");
    await expect(
      t.action(api.outgoingWebhookActions.testValidateWebhookUrl, {
        url: "https://localhost/hook",
      }),
    ).rejects.toThrow("Local");
    await expect(
      t.action(api.outgoingWebhookActions.testValidateWebhookUrl, {
        url: "https://192.168.1.2/hook",
      }),
    ).rejects.toThrow("prohibited");
    await expect(
      t.action(api.outgoingWebhookActions.testValidateWebhookUrl, {
        url: "https://[::1]/hook",
      }),
    ).rejects.toThrow("prohibited");
  });

  it("removes user payload state without deleting tenant-wide endpoint configuration", async () => {
    const t = createTest();
    await enable(t);
    const tenantEndpoint = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "tenant",
      url: "https://tenant.example.com/",
      eventTypes: ["workout.upserted"],
      payloadMode: "reference",
      encryptedSigningSecret: "tenant-secret",
    });
    const userEndpoint = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "user",
      userId: "user-1",
      url: "https://user.example.com/",
      eventTypes: ["workout.upserted"],
      payloadMode: "reference",
      encryptedSigningSecret: "user-secret",
    });
    const eventId = await t.run(
      async (ctx) =>
        await ctx.db.insert("outgoingWebhookEvents", {
          eventPublicId: "private-event",
          tenantId: "tenant-1",
          userId: "user-1",
          provider: "garmin",
          eventType: "workout.upserted",
          eventVersion: 1,
          subjectKind: "workout",
          idempotencyKey: "private-event",
          payloadJson: '{"health":true}',
          occurredAt: 1,
          fanoutStatus: "completed",
          expiresAt: Date.now() + 60_000,
        }),
    );
    await t.run(
      async (ctx) =>
        await ctx.db.insert("outgoingWebhookDeliveries", {
          eventId,
          endpointId: tenantEndpoint,
          tenantId: "tenant-1",
          userId: "user-1",
          provider: "garmin",
          status: "pending",
          attemptCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
    );
    await t.mutation(internal.outgoingWebhooks.deleteUserOutgoingState, { userId: "user-1" });
    expect(await t.run(async (ctx) => await ctx.db.get(eventId))).toBeNull();
    expect(
      (
        await t.query(internal.outgoingWebhooks.getEndpointInternal, {
          endpointId: tenantEndpoint,
        })
      )?.status,
    ).toBe("pending_verification");
    expect(
      (
        await t.query(internal.outgoingWebhooks.getEndpointInternal, {
          endpointId: userEndpoint,
        })
      )?.status,
    ).toBe("deleted");
  });

  it("creates host-visible durable recovery operations", async () => {
    const t = createTest();
    await enable(t);
    const endpointId = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "tenant",
      url: "https://hooks.example.com/",
      eventTypes: ["sync.failed"],
      payloadMode: "reference",
      encryptedSigningSecret: "secret",
    });
    await t.mutation(internal.outgoingWebhooks.activateEndpoint, { endpointId });
    const started = await t.mutation(api.outgoingWebhooks.recoverFailedWebhookDeliveries, {
      tenantId: "tenant-1",
      endpointId,
      since: Date.now() - 60_000,
    });
    expect(started.workflowId).toBeDefined();
    expect(
      await t.query(api.outgoingWebhooks.getWebhookRecoveryOperation, {
        tenantId: "tenant-1",
        operationId: started.operationId,
      }),
    ).toMatchObject({ kind: "recover_failed", status: "pending", processed: 0 });
  });

  it("keeps deleted endpoints terminal and drains expired recovery rows", async () => {
    const t = createTest();
    await enable(t);
    const endpointId = await t.mutation(internal.outgoingWebhooks.prepareEndpoint, {
      tenantId: "tenant-1",
      scope: "tenant",
      url: "https://hooks.example.com/",
      eventTypes: ["sync.failed"],
      payloadMode: "reference",
      encryptedSigningSecret: "secret",
    });
    await t.mutation(internal.outgoingWebhooks.activateEndpoint, { endpointId });
    const { deliveryId, operationId } = await t.run(async (ctx) => {
      const now = Date.now();
      const eventId = await ctx.db.insert("outgoingWebhookEvents", {
        eventPublicId: "expired-event",
        tenantId: "tenant-1",
        eventType: "sync.failed",
        eventVersion: 1,
        subjectKind: "sync",
        idempotencyKey: "expired-event",
        payloadJson: "{}",
        occurredAt: now - 2_000,
        fanoutStatus: "completed",
        expiresAt: now - 1_000,
      });
      const deliveryId = await ctx.db.insert("outgoingWebhookDeliveries", {
        eventId,
        endpointId,
        tenantId: "tenant-1",
        status: "failed",
        attemptCount: 8,
        createdAt: now - 1_000,
        updatedAt: now - 1_000,
      });
      const operationId = await ctx.db.insert("outgoingWebhookOperations", {
        tenantId: "tenant-1",
        endpointId,
        kind: "recover_failed",
        since: now - 60_000,
        until: now,
        status: "running",
        processed: 0,
        createdAt: now,
        updatedAt: now,
      });
      return { deliveryId, operationId };
    });

    await expect(
      t.mutation(internal.outgoingWebhooks.processRecoveryOperation, { operationId }),
    ).resolves.toEqual({ done: true, processed: 0 });
    expect(await t.run(async (ctx) => await ctx.db.get(deliveryId))).toMatchObject({
      status: "canceled",
      lastErrorCode: "event_expired",
    });

    await t.mutation(api.outgoingWebhooks.deleteWebhookEndpoint, {
      tenantId: "tenant-1",
      endpointId,
    });
    await expect(
      t.mutation(api.outgoingWebhooks.resumeWebhookEndpoint, {
        tenantId: "tenant-1",
        endpointId,
      }),
    ).rejects.toThrow("cannot be reactivated");
  });
});
