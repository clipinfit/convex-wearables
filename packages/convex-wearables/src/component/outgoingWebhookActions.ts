import type { FunctionHandle } from "convex/server";
import { v } from "convex/values";
import type { OutgoingWebhookHostRequest } from "../client/outgoingWebhookProtocol";
import { internal } from "./_generated/api";
import { type ActionCtx, action, internalAction } from "./_generated/server";

async function runHost(ctx: ActionCtx, request: OutgoingWebhookHostRequest) {
  const handle = await ctx.runQuery(internal.outgoingWebhooks.getHostActionHandle, {});
  if (!handle) throw new Error("Outgoing webhooks require a configured hostActionHandle");
  // Convex function handles are opaque strings. Convex validates the target at runAction.
  return await ctx.runAction(handle as FunctionHandle<"action">, { request });
}

export const createWebhookEndpoint = action({
  args: {
    tenantId: v.string(),
    scope: v.union(v.literal("tenant"), v.literal("user")),
    userId: v.optional(v.string()),
    url: v.string(),
    description: v.optional(v.string()),
    eventTypes: v.array(v.string()),
    payloadMode: v.optional(v.union(v.literal("reference"), v.literal("snapshot"))),
  },
  returns: v.any(),
  handler: async (ctx, args) => await runHost(ctx, { kind: "createEndpoint", ...args }),
});

export const verifyWebhookEndpoint = action({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.any(),
  handler: async (ctx, args) => await runHost(ctx, { kind: "verifyEndpoint", ...args }),
});

export const updateWebhookEndpointUrl = action({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints"), url: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => await runHost(ctx, { kind: "updateEndpointUrl", ...args }),
});

export const rotateWebhookSecret = action({
  args: {
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    overlapMs: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => await runHost(ctx, { kind: "rotateSecret", ...args }),
});

export const rewrapWebhookEndpointSecret = action({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.null(),
  handler: async (ctx, args) => await runHost(ctx, { kind: "rewrapSecret", ...args }),
});

export const sendWebhookTest = action({
  args: {
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    eventType: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, args) =>
    String(
      await ctx.runMutation(internal.outgoingWebhooks.emitTestEvent, {
        ...args,
        eventType: args.eventType ?? "connection.status_changed",
      }),
    ),
});

export const dispatchInternalCallback = internalAction({
  args: { eventId: v.id("outgoingWebhookEvents") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const bundle = await ctx.runQuery(internal.outgoingWebhooks.getEventForCallback, args);
    if (!bundle?.handle || !bundle.payloadJson) return false;
    const payload = JSON.parse(bundle.payloadJson);
    if (bundle.kind === "mutation") await ctx.runMutation(bundle.handle as never, payload);
    else await ctx.runAction(bundle.handle as never, payload);
    return true;
  },
});

export const deliverWebhook = internalAction({
  args: { deliveryId: v.id("outgoingWebhookDeliveries"), leaseToken: v.string() },
  returns: v.object({
    startedAt: v.number(),
    durationMs: v.number(),
    success: v.boolean(),
    permanent: v.boolean(),
    responseStatus: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
  }),
  handler: async (ctx, args) => await runHost(ctx, { kind: "deliver", ...args }),
});

export const testValidateWebhookUrl = action({
  args: { url: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => await runHost(ctx, { kind: "validateUrl", ...args }),
});

export const getOutgoingWebhookRuntimeStatus = action({
  args: {},
  returns: v.object({
    encryptionKeyConfigured: v.boolean(),
    previousEncryptionKeyConfigured: v.boolean(),
    nativePinnedDelivery: v.boolean(),
  }),
  handler: async (ctx) => {
    const handle = await ctx.runQuery(internal.outgoingWebhooks.getHostActionHandle, {});
    if (!handle) {
      return {
        encryptionKeyConfigured: false,
        previousEncryptionKeyConfigured: false,
        nativePinnedDelivery: false,
      };
    }
    return await runHost(ctx, { kind: "runtimeStatus" });
  },
});
