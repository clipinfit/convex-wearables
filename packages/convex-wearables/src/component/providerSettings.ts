import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { providerName } from "./schema";

export const upsertCredentials = internalMutation({
  args: {
    provider: providerName,
    clientId: v.string(),
    clientSecret: v.string(),
    subscriptionKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerSettings")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();

    const patch = {
      provider: args.provider,
      isEnabled: true,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      subscriptionKey: args.subscriptionKey,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }

    return await ctx.db.insert("providerSettings", patch);
  },
});

export const getCredentials = internalQuery({
  args: {
    provider: providerName,
  },
  returns: v.union(
    v.object({
      provider: providerName,
      clientId: v.string(),
      clientSecret: v.string(),
      subscriptionKey: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("providerSettings")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();

    if (!settings?.clientId || !settings.clientSecret) {
      return null;
    }

    return {
      provider: settings.provider,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      subscriptionKey: settings.subscriptionKey,
    };
  },
});
