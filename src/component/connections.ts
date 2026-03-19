import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { connectionStatus, providerName } from "./schema";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all connections for a user.
 */
export const getConnections = query({
  args: { userId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_user", (idx) => idx.eq("userId", args.userId))
      .collect();

    // Strip sensitive token fields before returning
    return connections.map((conn) => ({
      _id: conn._id,
      _creationTime: conn._creationTime,
      userId: conn.userId,
      provider: conn.provider,
      providerUserId: conn.providerUserId,
      providerUsername: conn.providerUsername,
      status: conn.status,
      lastSyncedAt: conn.lastSyncedAt,
    }));
  },
});

/**
 * Get a specific connection by user + provider.
 */
export const getByUserProvider = query({
  args: {
    userId: v.string(),
    provider: providerName,
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    const conn = await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (idx) =>
        idx.eq("userId", args.userId).eq("provider", args.provider),
      )
      .first();

    if (!conn) {
      return null;
    }

    return {
      _id: conn._id,
      _creationTime: conn._creationTime,
      userId: conn.userId,
      provider: conn.provider,
      providerUserId: conn.providerUserId,
      providerUsername: conn.providerUsername,
      status: conn.status,
      lastSyncedAt: conn.lastSyncedAt,
    };
  },
});

/**
 * Get all active connections (for periodic sync).
 */
export const getAllActive = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    return await ctx.db
      .query("connections")
      .withIndex("by_status", (idx) => idx.eq("status", "active"))
      .collect();
  },
});

export const getById = internalQuery({
  args: {
    connectionId: v.id("connections"),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db.get(args.connectionId);
  },
});

export const getByProviderUser = internalQuery({
  args: {
    provider: providerName,
    providerUserId: v.string(),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("connections")
      .withIndex("by_provider_user", (idx) =>
        idx.eq("provider", args.provider).eq("providerUserId", args.providerUserId),
      )
      .first();
  },
});

/**
 * Get sync status for a user across all their connections.
 */
export const getSyncStatus = query({
  args: { userId: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_user", (idx) => idx.eq("userId", args.userId))
      .collect();

    const statuses = [];
    for (const conn of connections) {
      const latestJob = await ctx.db
        .query("syncJobs")
        .withIndex("by_connection", (idx) => idx.eq("connectionId", conn._id))
        .order("desc")
        .first();

      statuses.push({
        provider: conn.provider,
        connectionStatus: conn.status,
        lastSyncedAt: conn.lastSyncedAt,
        syncJobStatus: latestJob?.status ?? null,
        syncJobError: latestJob?.error ?? null,
      });
    }

    return statuses;
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a new connection (after successful OAuth token exchange).
 */
export const createConnection = internalMutation({
  args: {
    userId: v.string(),
    provider: providerName,
    providerUserId: v.optional(v.string()),
    providerUsername: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
  },
  returns: v.id("connections"),
  handler: async (ctx, args) => {
    // Check if connection already exists
    const existing = await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (idx) =>
        idx.eq("userId", args.userId).eq("provider", args.provider),
      )
      .first();

    if (existing) {
      // Re-activate and update tokens
      await ctx.db.patch(existing._id, {
        ...args,
        status: "active",
      });
      return existing._id;
    }

    return await ctx.db.insert("connections", {
      ...args,
      status: "active",
    });
  },
});

/**
 * Ensure a push-based provider connection exists for SDK-ingested providers
 * like Apple Health or Google Health Connect.
 */
export const ensurePushConnection = internalMutation({
  args: {
    userId: v.string(),
    provider: providerName,
    providerUserId: v.optional(v.string()),
    providerUsername: v.optional(v.string()),
  },
  returns: v.id("connections"),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (idx) =>
        idx.eq("userId", args.userId).eq("provider", args.provider),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        providerUserId: args.providerUserId ?? existing.providerUserId,
        providerUsername: args.providerUsername ?? existing.providerUsername,
        status: "active",
      });
      return existing._id;
    }

    return await ctx.db.insert("connections", {
      userId: args.userId,
      provider: args.provider,
      providerUserId: args.providerUserId,
      providerUsername: args.providerUsername,
      status: "active",
    });
  },
});

/**
 * Update OAuth tokens (e.g., after refresh).
 */
export const updateTokens = internalMutation({
  args: {
    connectionId: v.id("connections"),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { connectionId, ...updates } = args;
    await ctx.db.patch(connectionId, updates);
  },
});

/**
 * Mark a connection as synced (update lastSyncedAt).
 */
export const markSynced = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      lastSyncedAt: Date.now(),
    });
  },
});

/**
 * Update connection status.
 */
export const updateStatus = internalMutation({
  args: {
    connectionId: v.id("connections"),
    status: connectionStatus,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, { status: args.status });
  },
});

/**
 * Update the stored OAuth scope / permissions for a connection.
 */
export const updateScope = internalMutation({
  args: {
    connectionId: v.id("connections"),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.connectionId, {
      scope: args.scope,
    });
  },
});

/**
 * Disconnect a provider — sets status to inactive.
 */
export const disconnect = mutation({
  args: {
    userId: v.string(),
    provider: providerName,
  },
  handler: async (ctx, args) => {
    const conn = await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (idx) =>
        idx.eq("userId", args.userId).eq("provider", args.provider),
      )
      .first();

    if (conn) {
      await ctx.db.patch(conn._id, {
        status: "inactive",
        accessToken: undefined,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
      });
    }
  },
});

/**
 * Delete a connection and all associated data sources.
 */
export const deleteConnection = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, args) => {
    // Delete associated data sources
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_connection", (idx) => idx.eq("connectionId", args.connectionId))
      .collect();

    for (const source of sources) {
      await ctx.db.delete(source._id);
    }

    await ctx.db.delete(args.connectionId);
  },
});
