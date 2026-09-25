import workflowTest from "@convex-dev/workflow/test";
import workpoolTest from "@convex-dev/workpool/test";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { api } from "../component/_generated/api";
import type { ComponentApi } from "../component/_generated/component";
import schema from "../component/schema";
import { modules } from "../component/test.setup";
import { runOutgoingWebhookHostRequest } from "./outgoingWebhookNode";

const testKey = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  process.env.CONVEX_WEARABLES_WEBHOOK_ENCRYPTION_KEY = testKey;
});

afterEach(() => {
  delete process.env.CONVEX_WEARABLES_WEBHOOK_ENCRYPTION_KEY;
});

describe("host Node webhook adapter", () => {
  it("creates, rotates, and updates endpoints through the component bridge", async () => {
    const t = convexTest(schema, modules);
    t.registerComponent("outgoingWebhookWorkflow", workflowTest.schema, workflowTest.modules);
    workpoolTest.register(t, "outgoingWebhookWorkflow/workpool");
    await t.mutation(api.outgoingWebhooks.configureOutgoingWebhooks, {
      captureEnabled: true,
      externalDeliveryEnabled: true,
      hostActionHandle: "test-host-action",
    });
    const ctx = {
      runAction: async (_reference: unknown, args: unknown) =>
        await t.action(api.outgoingWebhookBridge.execute, args),
    } as unknown as GenericActionCtx<GenericDataModel>;
    const component = {
      outgoingWebhookBridge: { execute: api.outgoingWebhookBridge.execute },
    } as unknown as ComponentApi;

    const created = await runOutgoingWebhookHostRequest(ctx, component, {
      kind: "createEndpoint",
      tenantId: "tenant-1",
      scope: "tenant",
      url: "https://8.8.8.8/hook",
      eventTypes: ["workout.upserted"],
    });
    expect(created).toMatchObject({ status: "pending_verification" });
    if (!created || typeof created !== "object" || !("endpointId" in created)) {
      throw new Error("Endpoint was not created");
    }
    const endpointId = String(created.endpointId);
    const rotated = await runOutgoingWebhookHostRequest(ctx, component, {
      kind: "rotateSecret",
      tenantId: "tenant-1",
      endpointId,
    });
    expect(rotated).toMatchObject({ endpointId });
    await runOutgoingWebhookHostRequest(ctx, component, {
      kind: "updateEndpointUrl",
      tenantId: "tenant-1",
      endpointId,
      url: "https://8.8.4.4/new-hook",
    });
    const endpoint = await t.action(api.outgoingWebhookBridge.execute, {
      operation: "getEndpoint",
      payload: { endpointId },
    });
    expect(endpoint).toMatchObject({ url: "https://8.8.4.4/new-hook", signingKeyVersion: 2 });
  });
});
