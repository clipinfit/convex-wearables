import { type Infer, v } from "convex/values";

/** The request accepted by an opt-in Node action in the host application. */
export const outgoingWebhookHostRequest = v.union(
  v.object({ kind: v.literal("runtimeStatus") }),
  v.object({ kind: v.literal("validateUrl"), url: v.string() }),
  v.object({
    kind: v.literal("createEndpoint"),
    tenantId: v.string(),
    scope: v.union(v.literal("tenant"), v.literal("user")),
    userId: v.optional(v.string()),
    url: v.string(),
    description: v.optional(v.string()),
    eventTypes: v.array(v.string()),
    payloadMode: v.optional(v.union(v.literal("reference"), v.literal("snapshot"))),
  }),
  v.object({ kind: v.literal("verifyEndpoint"), tenantId: v.string(), endpointId: v.string() }),
  v.object({
    kind: v.literal("updateEndpointUrl"),
    tenantId: v.string(),
    endpointId: v.string(),
    url: v.string(),
  }),
  v.object({
    kind: v.literal("rotateSecret"),
    tenantId: v.string(),
    endpointId: v.string(),
    overlapMs: v.optional(v.number()),
  }),
  v.object({ kind: v.literal("rewrapSecret"), tenantId: v.string(), endpointId: v.string() }),
  v.object({ kind: v.literal("deliver"), deliveryId: v.string(), leaseToken: v.string() }),
);

export type OutgoingWebhookHostRequest = Infer<typeof outgoingWebhookHostRequest>;
