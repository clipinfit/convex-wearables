import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";

/**
 * Component functions cannot use Node APIs. This bridge lets the opt-in host
 * Node action call the existing validated component queries and mutations.
 * The host action is internal; the final target validates every payload.
 */
export const execute = action({
  args: {
    operation: v.union(
      v.literal("prepareEndpoint"),
      v.literal("getEndpoint"),
      v.literal("patchEndpointUrl"),
      v.literal("replaceEndpointSecret"),
      v.literal("rewrapEndpointSecrets"),
      v.literal("activateEndpoint"),
      v.literal("renewDeliveryLease"),
      v.literal("getDeliveryBundle"),
    ),
    payload: v.any(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    switch (args.operation) {
      case "prepareEndpoint":
        return await ctx.runMutation(internal.outgoingWebhooks.prepareEndpoint, args.payload);
      case "getEndpoint":
        return await ctx.runQuery(internal.outgoingWebhooks.getEndpointInternal, args.payload);
      case "patchEndpointUrl":
        return await ctx.runMutation(internal.outgoingWebhooks.patchEndpointUrl, args.payload);
      case "replaceEndpointSecret":
        return await ctx.runMutation(internal.outgoingWebhooks.replaceEndpointSecret, args.payload);
      case "rewrapEndpointSecrets":
        return await ctx.runMutation(internal.outgoingWebhooks.rewrapEndpointSecrets, args.payload);
      case "activateEndpoint":
        return await ctx.runMutation(internal.outgoingWebhooks.activateEndpoint, args.payload);
      case "renewDeliveryLease":
        return await ctx.runMutation(internal.outgoingWebhooks.renewDeliveryLease, args.payload);
      case "getDeliveryBundle":
        return await ctx.runQuery(internal.outgoingWebhooks.getDeliveryBundle, args.payload);
    }
  },
});
