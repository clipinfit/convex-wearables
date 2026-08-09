import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { outgoingWebhookDeliveryStatus, providerName } from "./schema";
import { outgoingWebhookWorkflow } from "./workflowManager";

export const WEARABLES_EVENT_TYPES = [
  "connection.created",
  "connection.status_changed",
  "sync.started",
  "sync.completed",
  "sync.failed",
  "workout.upserted",
  "workout.enriched",
  "workout.deleted",
  "sleep.upserted",
  "sleep.deleted",
  "summary.upserted",
  "series.batch.upserted",
  "data_deletion.started",
  "data_deletion.completed",
  "data_deletion.completed_with_warnings",
] as const;

export type WearablesEventType =
  | (typeof WEARABLES_EVENT_TYPES)[number]
  | `series.${string}.upserted`;

const EVENT_GROUPS = [
  "connection.*",
  "sync.*",
  "workout.*",
  "sleep.*",
  "summary.*",
  "series.*",
  "data_deletion.*",
] as const;
const DEFAULT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const ATTEMPT_SUCCESS_RETENTION_MS = 7 * 24 * 60 * 60_000;
const ATTEMPT_FAILURE_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DELIVERY_RETRY_DELAYS_MS = [
  0,
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  5 * 60 * 60_000,
  10 * 60 * 60_000,
  10 * 60 * 60_000,
] as const;
const MAX_LIST_LIMIT = 100;
const MAX_EVENT_TYPES = 64;
const MAX_RECOVERY_ROWS = 100;
const LEASE_MS = 2 * 60_000;

const endpointScope = v.union(v.literal("tenant"), v.literal("user"));
const payloadMode = v.union(v.literal("reference"), v.literal("snapshot"));

function defaultConfig() {
  return {
    key: "default" as const,
    captureEnabled: false,
    externalDeliveryEnabled: false,
    snapshotPayloadsEnabled: false,
    internalCallbackHandle: undefined as string | undefined,
    internalCallbackKind: undefined as "action" | "mutation" | undefined,
    maxEndpointsPerTenant: 20,
    maxEndpointsPerUser: 5,
    eventRetentionMs: DEFAULT_EVENT_RETENTION_MS,
    updatedAt: 0,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function outgoingEventFingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function expandEventTypes(requested: string[]): string[] {
  if (requested.length === 0 || requested.length > MAX_EVENT_TYPES) {
    throw new Error(`eventTypes must contain 1-${MAX_EVENT_TYPES} entries`);
  }
  const known = new Set<string>(WEARABLES_EVENT_TYPES);
  const expanded = new Set<string>();
  for (const item of requested) {
    if ((EVENT_GROUPS as readonly string[]).includes(item)) {
      const prefix = item.slice(0, -1);
      for (const candidate of WEARABLES_EVENT_TYPES) {
        if (candidate.startsWith(prefix)) expanded.add(candidate);
      }
      continue;
    }
    if (!known.has(item) && !/^series\.[a-z0-9_]+\.upserted$/.test(item)) {
      throw new Error(`Unsupported wearable event type: ${item}`);
    }
    expanded.add(item);
  }
  return [...expanded].sort();
}

function safeEndpoint(endpoint: Record<string, unknown>) {
  const {
    encryptedSigningSecret: _secret,
    previousEncryptedSigningSecret: _previous,
    ...safe
  } = endpoint;
  const url = new URL(String(endpoint.url));
  url.search = "";
  return {
    ...safe,
    url: url.toString(),
    hasQueryParameters: new URL(String(endpoint.url)).search.length > 0,
  };
}

export type CaptureOutgoingEventArgs = {
  userId: string;
  provider?: string;
  eventType: WearablesEventType;
  subjectKind: "connection" | "sync" | "workout" | "sleep" | "summary" | "series" | "deletion";
  subjectId?: string;
  idempotencyKey: string;
  data: Record<string, unknown>;
  snapshotData?: Record<string, unknown>;
  occurredAt?: number;
};

/** Called inside source mutations so outbox creation and scheduling are transactional. */
export async function captureOutgoingEvent(
  ctx: MutationCtx,
  args: CaptureOutgoingEventArgs,
): Promise<Id<"outgoingWebhookEvents"> | null> {
  const config =
    (await ctx.db
      .query("outgoingWebhookConfiguration")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first()) ?? defaultConfig();
  if (!config.captureEnabled) return null;
  const mapping = await ctx.db
    .query("outgoingWebhookUserTenants")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .first();
  if (!mapping) return null;
  const existing = await ctx.db
    .query("outgoingWebhookEvents")
    .withIndex("by_tenant_idempotency_key", (q) =>
      q.eq("tenantId", mapping.tenantId).eq("idempotencyKey", args.idempotencyKey),
    )
    .first();
  if (existing) return existing._id;
  const occurredAt = args.occurredAt ?? Date.now();
  const eventPublicId = crypto.randomUUID();
  const envelopeBase = {
    id: eventPublicId,
    type: args.eventType,
    version: 1,
    occurredAt,
    tenantId: mapping.tenantId,
    userId: args.userId,
    provider: args.provider,
    subject: { kind: args.subjectKind, id: args.subjectId },
    idempotencyKey: args.idempotencyKey,
  };
  const referenceEnvelope = { ...envelopeBase, data: args.data };
  const envelope = {
    ...envelopeBase,
    data: config.snapshotPayloadsEnabled ? (args.snapshotData ?? args.data) : args.data,
  };
  const payloadJson = canonicalJson(envelope);
  const referencePayloadJson = canonicalJson(referenceEnvelope);
  if (new TextEncoder().encode(payloadJson).byteLength > 512_000) {
    throw new Error("Outgoing wearable event exceeds the 512 KiB hard limit");
  }
  const eventId = await ctx.db.insert("outgoingWebhookEvents", {
    eventPublicId,
    tenantId: mapping.tenantId,
    userId: args.userId,
    provider: args.provider as never,
    eventType: args.eventType,
    eventVersion: 1,
    subjectKind: args.subjectKind,
    subjectId: args.subjectId,
    idempotencyKey: args.idempotencyKey,
    payloadJson,
    referencePayloadJson,
    occurredAt,
    fanoutStatus: "pending",
    expiresAt: occurredAt + config.eventRetentionMs,
  });
  const workflowId = await outgoingWebhookWorkflow.start(
    ctx,
    internal.outgoingWebhooks.runFanoutWorkflow,
    { eventId },
    { startAsync: true },
  );
  await ctx.db.patch(eventId, { workflowId });
  await ctx.scheduler.runAt(
    occurredAt + config.eventRetentionMs,
    internal.outgoingWebhooks.cleanupExpired,
    {},
  );
  return eventId;
}

export const configureOutgoingWebhooks = mutation({
  args: {
    captureEnabled: v.boolean(),
    externalDeliveryEnabled: v.optional(v.boolean()),
    snapshotPayloadsEnabled: v.optional(v.boolean()),
    internalCallbackHandle: v.optional(v.string()),
    internalCallbackKind: v.optional(v.union(v.literal("action"), v.literal("mutation"))),
    clearInternalCallback: v.optional(v.boolean()),
    maxEndpointsPerTenant: v.optional(v.number()),
    maxEndpointsPerUser: v.optional(v.number()),
    eventRetentionMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("outgoingWebhookConfiguration")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first();
    const base = existing ?? defaultConfig();
    const eventRetentionMs = args.eventRetentionMs ?? base.eventRetentionMs;
    if (eventRetentionMs < 60 * 60_000 || eventRetentionMs > DEFAULT_EVENT_RETENTION_MS) {
      throw new Error("eventRetentionMs must be between one hour and 30 days");
    }
    const internalCallbackHandle = args.clearInternalCallback
      ? undefined
      : (args.internalCallbackHandle ?? base.internalCallbackHandle);
    const value = {
      ...base,
      captureEnabled: args.captureEnabled,
      externalDeliveryEnabled: args.externalDeliveryEnabled ?? base.externalDeliveryEnabled,
      snapshotPayloadsEnabled: args.snapshotPayloadsEnabled ?? base.snapshotPayloadsEnabled,
      internalCallbackHandle,
      internalCallbackKind: internalCallbackHandle
        ? (args.internalCallbackKind ?? base.internalCallbackKind ?? "action")
        : undefined,
      maxEndpointsPerTenant: Math.min(
        Math.max(args.maxEndpointsPerTenant ?? base.maxEndpointsPerTenant, 1),
        100,
      ),
      maxEndpointsPerUser: Math.min(
        Math.max(args.maxEndpointsPerUser ?? base.maxEndpointsPerUser, 1),
        20,
      ),
      eventRetentionMs,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("outgoingWebhookConfiguration", value);
    return null;
  },
});

export const getOutgoingWebhookStatus = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const config =
      (await ctx.db
        .query("outgoingWebhookConfiguration")
        .withIndex("by_key", (q) => q.eq("key", "default"))
        .first()) ?? defaultConfig();
    const [activeEndpoints, disabledEndpoints, pending, delivering, retryScheduled, failed] =
      await Promise.all([
        ctx.db
          .query("outgoingWebhookEndpoints")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .take(1_001),
        ctx.db
          .query("outgoingWebhookEndpoints")
          .withIndex("by_status", (q) => q.eq("status", "disabled"))
          .take(1_001),
        ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_status_next_attempt", (q) => q.eq("status", "pending"))
          .take(1_001),
        ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_status_next_attempt", (q) => q.eq("status", "delivering"))
          .take(1_001),
        ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_status_next_attempt", (q) => q.eq("status", "retry_scheduled"))
          .take(1_001),
        ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_status_next_attempt", (q) => q.eq("status", "failed"))
          .take(1_001),
      ]);
    return {
      captureEnabled: config.captureEnabled,
      externalDeliveryEnabled: config.externalDeliveryEnabled,
      snapshotPayloadsEnabled: config.snapshotPayloadsEnabled,
      internalCallbackConfigured: Boolean(config.internalCallbackHandle),
      internalCallbackKind: config.internalCallbackKind,
      activeEndpoints: Math.min(activeEndpoints.length, 1_000),
      disabledEndpoints: Math.min(disabledEndpoints.length, 1_000),
      pendingDeliveries: Math.min(
        pending.length + delivering.length + retryScheduled.length,
        1_000,
      ),
      failedDeliveries: Math.min(failed.length, 1_000),
      countsCapped:
        activeEndpoints.length > 1_000 ||
        disabledEndpoints.length > 1_000 ||
        pending.length > 1_000 ||
        delivering.length > 1_000 ||
        retryScheduled.length > 1_000 ||
        pending.length + delivering.length + retryScheduled.length > 1_000 ||
        failed.length > 1_000,
    };
  },
});

export const setWebhookUserTenant = mutation({
  args: { userId: v.string(), tenantId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!args.userId.trim() || !args.tenantId.trim())
      throw new Error("userId and tenantId are required");
    const existing = await ctx.db
      .query("outgoingWebhookUserTenants")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (existing)
      await ctx.db.patch(existing._id, { tenantId: args.tenantId, updatedAt: Date.now() });
    else await ctx.db.insert("outgoingWebhookUserTenants", { ...args, updatedAt: Date.now() });
    return null;
  },
});

export const getConfigurationInternal = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) =>
    (await ctx.db
      .query("outgoingWebhookConfiguration")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first()) ?? defaultConfig(),
});

export const prepareEndpoint = internalMutation({
  args: {
    tenantId: v.string(),
    scope: endpointScope,
    userId: v.optional(v.string()),
    url: v.string(),
    description: v.optional(v.string()),
    eventTypes: v.array(v.string()),
    payloadMode,
    encryptedSigningSecret: v.string(),
  },
  returns: v.id("outgoingWebhookEndpoints"),
  handler: async (ctx, args) => {
    if (!args.tenantId.trim()) throw new Error("tenantId is required");
    if (args.scope === "user" && !args.userId) throw new Error("user scope requires userId");
    if (args.scope === "tenant" && args.userId)
      throw new Error("tenant scope cannot include userId");
    if ((args.description?.length ?? 0) > 500) throw new Error("description is too long");
    if (args.userId) {
      const userId = args.userId;
      const mapping = await ctx.db
        .query("outgoingWebhookUserTenants")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      if (mapping?.tenantId !== args.tenantId) {
        throw new Error("User is not mapped to the endpoint tenant");
      }
    }
    const config =
      (await ctx.db
        .query("outgoingWebhookConfiguration")
        .withIndex("by_key", (q) => q.eq("key", "default"))
        .first()) ?? defaultConfig();
    if (!config.captureEnabled || !config.externalDeliveryEnabled)
      throw new Error("External outgoing webhooks are disabled");
    if (args.payloadMode === "snapshot" && !config.snapshotPayloadsEnabled)
      throw new Error("Snapshot payloads are disabled");
    const tenantRows = (
      await Promise.all(
        (["pending_verification", "active", "paused", "disabled"] as const).map(
          async (status) =>
            await ctx.db
              .query("outgoingWebhookEndpoints")
              .withIndex("by_tenant_status", (q) =>
                q.eq("tenantId", args.tenantId).eq("status", status),
              )
              .take(config.maxEndpointsPerTenant + 1),
        ),
      )
    ).flat();
    if (tenantRows.length >= config.maxEndpointsPerTenant)
      throw new Error("Tenant endpoint limit reached");
    if (
      args.userId &&
      tenantRows.filter((row) => row.userId === args.userId).length >= config.maxEndpointsPerUser
    )
      throw new Error("User endpoint limit reached");
    const now = Date.now();
    return await ctx.db.insert("outgoingWebhookEndpoints", {
      ...args,
      eventTypes: expandEventTypes(args.eventTypes),
      status: "pending_verification",
      signingKeyVersion: 1,
      consecutiveFailureDays: 0,
      failureMessageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getEndpointInternal = internalQuery({
  args: { endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.get(args.endpointId),
});

export const patchEndpointUrl = internalMutation({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints"), url: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.endpointId);
    if (!row || row.tenantId !== args.tenantId) throw new Error("Webhook endpoint not found");
    if (row.status === "deleted") throw new Error("Deleted webhook endpoints cannot be updated");
    for (const deliveryStatus of ["pending", "retry_scheduled", "delivering"] as const) {
      const deliveries = await ctx.db
        .query("outgoingWebhookDeliveries")
        .withIndex("by_endpoint_status", (q) =>
          q.eq("endpointId", row._id).eq("status", deliveryStatus),
        )
        .collect();
      for (const delivery of deliveries) {
        await ctx.db.patch(delivery._id, {
          status: "canceled",
          nextAttemptAt: undefined,
          lockedAt: undefined,
          leaseToken: undefined,
          updatedAt: Date.now(),
        });
      }
    }
    await ctx.db.patch(row._id, {
      url: args.url,
      status: "pending_verification",
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const getEventForCallback = internalQuery({
  args: { eventId: v.id("outgoingWebhookEvents") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    const config = await ctx.db
      .query("outgoingWebhookConfiguration")
      .withIndex("by_key", (q) => q.eq("key", "default"))
      .first();
    return event
      ? {
          handle: config?.internalCallbackHandle,
          kind: config?.internalCallbackKind ?? "action",
          payloadJson: event.payloadJson,
        }
      : null;
  },
});

export const getDeliveryBundle = internalQuery({
  args: { deliveryId: v.id("outgoingWebhookDeliveries"), leaseToken: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (!delivery || delivery.status !== "delivering" || delivery.leaseToken !== args.leaseToken)
      return null;
    return {
      delivery,
      event: await ctx.db.get(delivery.eventId),
      endpoint: await ctx.db.get(delivery.endpointId),
      config:
        (await ctx.db
          .query("outgoingWebhookConfiguration")
          .withIndex("by_key", (q) => q.eq("key", "default"))
          .first()) ?? defaultConfig(),
    };
  },
});

export const activateEndpoint = internalMutation({
  args: { endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.endpointId);
    if (!row || row.status !== "pending_verification") {
      throw new Error("Only pending webhook endpoints can be activated");
    }
    await ctx.db.patch(row._id, {
      status: "active",
      disabledReason: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const listWebhookEndpoints = query({
  args: {
    tenantId: v.string(),
    userId: v.optional(v.string()),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_LIST_LIMIT);
    const endpointQuery = ctx.db
      .query("outgoingWebhookEndpoints")
      .withIndex("by_tenant_time", (q) => {
        const tenant = q.eq("tenantId", args.tenantId);
        return args.before ? tenant.lt("createdAt", args.before) : tenant;
      })
      .order("desc");
    const rows = args.userId
      ? await endpointQuery.filter((q) => q.eq(q.field("userId"), args.userId)).take(limit + 1)
      : await endpointQuery.take(limit + 1);
    return {
      endpoints: rows.slice(0, limit).map((row) => safeEndpoint(row)),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.createdAt ?? null) : null,
    };
  },
});

export const getWebhookEndpoint = query({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.endpointId);
    return row?.tenantId === args.tenantId ? safeEndpoint(row) : null;
  },
});

export const updateWebhookEndpoint = mutation({
  args: {
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    description: v.optional(v.string()),
    eventTypes: v.optional(v.array(v.string())),
    payloadMode: v.optional(payloadMode),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.endpointId);
    if (!row || row.tenantId !== args.tenantId) throw new Error("Webhook endpoint not found");
    if (row.status === "deleted") throw new Error("Deleted webhook endpoints cannot be updated");
    if ((args.description?.length ?? 0) > 500) throw new Error("description is too long");
    const config =
      (await ctx.db
        .query("outgoingWebhookConfiguration")
        .withIndex("by_key", (q) => q.eq("key", "default"))
        .first()) ?? defaultConfig();
    if (args.payloadMode === "snapshot" && !config.snapshotPayloadsEnabled)
      throw new Error("Snapshot payloads are disabled");
    await ctx.db.patch(row._id, {
      description: args.description ?? row.description,
      eventTypes: args.eventTypes ? expandEventTypes(args.eventTypes) : row.eventTypes,
      payloadMode: args.payloadMode ?? row.payloadMode,
      updatedAt: Date.now(),
    });
    return null;
  },
});

async function changeEndpointStatus(
  ctx: MutationCtx,
  tenantId: string,
  endpointId: Id<"outgoingWebhookEndpoints">,
  status: "active" | "paused" | "deleted",
) {
  const row = await ctx.db.get(endpointId);
  if (!row || row.tenantId !== tenantId) throw new Error("Webhook endpoint not found");
  if (row.status === "deleted" && status !== "deleted") {
    throw new Error("Deleted webhook endpoints cannot be reactivated");
  }
  await ctx.db.patch(row._id, {
    status,
    encryptedSigningSecret: status === "deleted" ? "deleted" : row.encryptedSigningSecret,
    previousEncryptedSigningSecret:
      status === "deleted" ? undefined : row.previousEncryptedSigningSecret,
    previousSecretValidUntil: status === "deleted" ? undefined : row.previousSecretValidUntil,
    url: status === "deleted" ? "https://deleted.invalid/" : row.url,
    description: status === "deleted" ? undefined : row.description,
    eventTypes: status === "deleted" ? [] : row.eventTypes,
    updatedAt: Date.now(),
    disabledReason: undefined,
  });
  if (status !== "active") {
    for (const deliveryStatus of ["pending", "retry_scheduled", "delivering"] as const) {
      const deliveries = await ctx.db
        .query("outgoingWebhookDeliveries")
        .withIndex("by_endpoint_status", (q) =>
          q.eq("endpointId", row._id).eq("status", deliveryStatus),
        )
        .collect();
      for (const delivery of deliveries)
        await ctx.db.patch(delivery._id, {
          status: "canceled",
          payloadJson: status === "deleted" ? "{}" : delivery.payloadJson,
          nextAttemptAt: undefined,
          lockedAt: undefined,
          leaseToken: undefined,
          updatedAt: Date.now(),
        });
    }
  }
}

export const pauseWebhookEndpoint = mutation({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await changeEndpointStatus(ctx, args.tenantId, args.endpointId, "paused");
    return null;
  },
});
export const resumeWebhookEndpoint = mutation({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await changeEndpointStatus(ctx, args.tenantId, args.endpointId, "active");
    return null;
  },
});
export const deleteWebhookEndpoint = mutation({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await changeEndpointStatus(ctx, args.tenantId, args.endpointId, "deleted");
    return null;
  },
});

export const replaceEndpointSecret = internalMutation({
  args: {
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    encryptedSigningSecret: v.string(),
    overlapMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.endpointId);
    if (!row || row.tenantId !== args.tenantId) throw new Error("Webhook endpoint not found");
    if (row.status === "deleted") throw new Error("Deleted webhook endpoints have no secret");
    await ctx.db.patch(row._id, {
      encryptedSigningSecret: args.encryptedSigningSecret,
      previousEncryptedSigningSecret: row.encryptedSigningSecret,
      previousSecretValidUntil:
        Date.now() + Math.min(Math.max(args.overlapMs, 0), 24 * 60 * 60_000),
      signingKeyVersion: row.signingKeyVersion + 1,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const rewrapEndpointSecrets = internalMutation({
  args: {
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    encryptedSigningSecret: v.string(),
    previousEncryptedSigningSecret: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.endpointId);
    if (!row || row.tenantId !== args.tenantId) throw new Error("Webhook endpoint not found");
    if (row.status === "deleted") throw new Error("Deleted webhook endpoints have no secret");
    await ctx.db.patch(row._id, {
      encryptedSigningSecret: args.encryptedSigningSecret,
      previousEncryptedSigningSecret: args.previousEncryptedSigningSecret,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const fanOutEvent = internalMutation({
  args: { eventId: v.id("outgoingWebhookEvents") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) return 0;
    const config =
      (await ctx.db
        .query("outgoingWebhookConfiguration")
        .withIndex("by_key", (q) => q.eq("key", "default"))
        .first()) ?? defaultConfig();
    await ctx.db.patch(event._id, { fanoutStatus: "running" });
    let created = 0;
    if (config.externalDeliveryEnabled) {
      const endpoints = await ctx.db
        .query("outgoingWebhookEndpoints")
        .withIndex("by_tenant_status", (q) =>
          q.eq("tenantId", event.tenantId).eq("status", "active"),
        )
        .take(100);
      for (const endpoint of endpoints) {
        if (endpoint.scope === "user" && endpoint.userId !== event.userId) continue;
        if (!endpoint.eventTypes.includes(event.eventType)) continue;
        const exists = await ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_event_endpoint", (q) =>
            q.eq("eventId", event._id).eq("endpointId", endpoint._id),
          )
          .first();
        if (exists) continue;
        const now = Date.now();
        const deliveryId = await ctx.db.insert("outgoingWebhookDeliveries", {
          eventId: event._id,
          endpointId: endpoint._id,
          tenantId: event.tenantId,
          userId: event.userId,
          provider: event.provider,
          payloadJson:
            endpoint.payloadMode === "snapshot"
              ? event.payloadJson
              : (event.referencePayloadJson ?? event.payloadJson),
          status: "pending",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        });
        await startDelivery(ctx, deliveryId);
        created++;
      }
    }
    await ctx.db.patch(event._id, { fanoutStatus: "completed" });
    return created;
  },
});

async function startDelivery(ctx: MutationCtx, deliveryId: Id<"outgoingWebhookDeliveries">) {
  await outgoingWebhookWorkflow.start(
    ctx,
    internal.outgoingWebhooks.runDeliveryWorkflow,
    { deliveryId },
    { startAsync: true },
  );
}

export const claimDelivery = internalMutation({
  args: { deliveryId: v.id("outgoingWebhookDeliveries") },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deliveryId);
    if (!row || !["pending", "retry_scheduled", "delivering"].includes(row.status)) return null;
    const now = Date.now();
    if (row.status === "retry_scheduled" && (row.nextAttemptAt ?? 0) > now) return null;
    if (row.status === "delivering" && (row.lockedAt ?? now) + LEASE_MS > now) return null;
    const endpoint = await ctx.db.get(row.endpointId);
    if (!endpoint || endpoint.status !== "active") return null;
    const active = await ctx.db
      .query("outgoingWebhookDeliveries")
      .withIndex("by_endpoint_status", (q) =>
        q.eq("endpointId", row.endpointId).eq("status", "delivering"),
      )
      .collect();
    if (
      active.filter((item) => item._id !== row._id && (item.lockedAt ?? now) + LEASE_MS > now)
        .length >= 2
    ) {
      await ctx.scheduler.runAfter(1_000, internal.outgoingWebhooks.wakeDelivery, {
        deliveryId: row._id,
      });
      return null;
    }
    const leaseToken = crypto.randomUUID();
    await ctx.db.patch(row._id, {
      status: "delivering",
      lockedAt: now,
      leaseToken,
      nextAttemptAt: undefined,
      lastAttemptAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(now + LEASE_MS, internal.outgoingWebhooks.recoverAbandonedDelivery, {
      deliveryId: row._id,
      leaseToken,
    });
    return leaseToken;
  },
});

export const recoverAbandonedDelivery = internalMutation({
  args: {
    deliveryId: v.id("outgoingWebhookDeliveries"),
    leaseToken: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deliveryId);
    if (
      !row ||
      row.status !== "delivering" ||
      row.leaseToken !== args.leaseToken ||
      (row.lockedAt ?? Date.now()) + LEASE_MS > Date.now()
    ) {
      return false;
    }
    const now = Date.now();
    const [endpoint, event] = await Promise.all([
      ctx.db.get(row.endpointId),
      ctx.db.get(row.eventId),
    ]);
    if (!endpoint || endpoint.status !== "active" || !event || event.expiresAt <= now) {
      await ctx.db.patch(row._id, {
        status: "canceled",
        lockedAt: undefined,
        leaseToken: undefined,
        lastErrorCode: !event || event.expiresAt <= now ? "event_expired" : "endpoint_inactive",
        updatedAt: now,
      });
      return false;
    }
    const attempt = row.attemptCount + 1;
    const exhausted = attempt >= DELIVERY_RETRY_DELAYS_MS.length;
    const attemptExpiresAt = now + ATTEMPT_FAILURE_RETENTION_MS;
    await ctx.db.insert("outgoingWebhookAttempts", {
      deliveryId: row._id,
      endpointId: row.endpointId,
      tenantId: row.tenantId,
      attempt,
      startedAt: row.lockedAt ?? now,
      completedAt: now,
      durationMs: Math.max(now - (row.lockedAt ?? now), 0),
      outcome: exhausted ? "permanent_failure" : "retryable_failure",
      errorCode: "worker_interrupted",
      expiresAt: attemptExpiresAt,
    });
    await ctx.scheduler.runAt(attemptExpiresAt, internal.outgoingWebhooks.cleanupExpired, {});
    if (exhausted) {
      await ctx.db.patch(row._id, {
        status: "failed",
        attemptCount: attempt,
        lockedAt: undefined,
        leaseToken: undefined,
        failedAt: now,
        lastErrorCode: "worker_interrupted",
        updatedAt: now,
      });
      return false;
    }
    const nextAttemptAt = now + DELIVERY_RETRY_DELAYS_MS[attempt];
    await ctx.db.patch(row._id, {
      status: "retry_scheduled",
      attemptCount: attempt,
      lockedAt: undefined,
      leaseToken: undefined,
      nextAttemptAt,
      lastErrorCode: "worker_interrupted",
      updatedAt: now,
    });
    await ctx.scheduler.runAt(nextAttemptAt, internal.outgoingWebhooks.wakeDelivery, {
      deliveryId: row._id,
    });
    return true;
  },
});

export const renewDeliveryLease = internalMutation({
  args: {
    deliveryId: v.id("outgoingWebhookDeliveries"),
    leaseToken: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deliveryId);
    if (!row || row.status !== "delivering" || row.leaseToken !== args.leaseToken) return false;
    const now = Date.now();
    await ctx.db.patch(row._id, { lockedAt: now, updatedAt: now });
    await ctx.scheduler.runAt(now + LEASE_MS, internal.outgoingWebhooks.recoverAbandonedDelivery, {
      deliveryId: row._id,
      leaseToken: args.leaseToken,
    });
    return true;
  },
});

export const finishDeliveryAttempt = internalMutation({
  args: {
    deliveryId: v.id("outgoingWebhookDeliveries"),
    leaseToken: v.string(),
    startedAt: v.number(),
    durationMs: v.number(),
    success: v.boolean(),
    permanent: v.boolean(),
    responseStatus: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    retryAfterMs: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deliveryId);
    if (!row || row.status !== "delivering" || row.leaseToken !== args.leaseToken) return null;
    const endpoint = await ctx.db.get(row.endpointId);
    const event = await ctx.db.get(row.eventId);
    const now = Date.now();
    const attempt = row.attemptCount + 1;
    const exhausted =
      attempt >= DELIVERY_RETRY_DELAYS_MS.length || !event || event.expiresAt <= now;
    const permanent = args.permanent || exhausted;
    const outcome = args.success
      ? "succeeded"
      : permanent
        ? "permanent_failure"
        : "retryable_failure";
    const attemptExpiresAt =
      now + (args.success ? ATTEMPT_SUCCESS_RETENTION_MS : ATTEMPT_FAILURE_RETENTION_MS);
    await ctx.db.insert("outgoingWebhookAttempts", {
      deliveryId: row._id,
      endpointId: row.endpointId,
      tenantId: row.tenantId,
      attempt,
      startedAt: args.startedAt,
      completedAt: now,
      durationMs: args.durationMs,
      outcome,
      responseStatus: args.responseStatus,
      errorCode: args.errorCode,
      expiresAt: attemptExpiresAt,
    });
    await ctx.scheduler.runAt(attemptExpiresAt, internal.outgoingWebhooks.cleanupExpired, {});
    if (args.success) {
      await ctx.db.patch(row._id, {
        status: "succeeded",
        attemptCount: attempt,
        lockedAt: undefined,
        leaseToken: undefined,
        lastResponseStatus: args.responseStatus,
        lastErrorCode: undefined,
        succeededAt: now,
        updatedAt: now,
      });
      if (endpoint)
        await ctx.db.patch(endpoint._id, {
          consecutiveFailureDays: 0,
          failureMessageCount: 0,
          firstRecentFailureAt: undefined,
          lastSuccessAt: now,
          updatedAt: now,
        });
      return null;
    }
    if (endpoint) {
      const first = endpoint.firstRecentFailureAt ?? now;
      const span = now - first;
      const messages = endpoint.failureMessageCount + 1;
      const disable =
        args.responseStatus === 410 ||
        (span >= 5 * 24 * 60 * 60_000 && messages >= 2 && span >= 12 * 60 * 60_000);
      await ctx.db.patch(endpoint._id, {
        lastFailureAt: now,
        firstRecentFailureAt: first,
        failureMessageCount: messages,
        consecutiveFailureDays: Math.floor(span / (24 * 60 * 60_000)) + 1,
        status: disable ? "disabled" : endpoint.status,
        disabledReason: disable
          ? args.responseStatus === 410
            ? "receiver_gone"
            : "chronic_failures"
          : endpoint.disabledReason,
        updatedAt: now,
      });
      if (disable) {
        for (const deliveryStatus of ["pending", "retry_scheduled", "delivering"] as const) {
          const queued = await ctx.db
            .query("outgoingWebhookDeliveries")
            .withIndex("by_endpoint_status", (q) =>
              q.eq("endpointId", endpoint._id).eq("status", deliveryStatus),
            )
            .collect();
          for (const item of queued) {
            if (item._id !== row._id) {
              await ctx.db.patch(item._id, {
                status: "canceled",
                nextAttemptAt: undefined,
                lockedAt: undefined,
                leaseToken: undefined,
                updatedAt: now,
              });
            }
          }
        }
        await ctx.db.patch(row._id, {
          status: "failed",
          attemptCount: attempt,
          lockedAt: undefined,
          leaseToken: undefined,
          failedAt: now,
          lastResponseStatus: args.responseStatus,
          lastErrorCode: args.errorCode,
          updatedAt: now,
        });
        return null;
      }
    }
    if (permanent) {
      await ctx.db.patch(row._id, {
        status: "failed",
        attemptCount: attempt,
        lockedAt: undefined,
        leaseToken: undefined,
        failedAt: now,
        lastResponseStatus: args.responseStatus,
        lastErrorCode: args.errorCode,
        updatedAt: now,
      });
      return null;
    }
    const standard = DELIVERY_RETRY_DELAYS_MS[attempt] ?? 10 * 60 * 60_000;
    const delay = Math.min(Math.max(args.retryAfterMs ?? standard, standard), 10 * 60 * 60_000);
    const nextAttemptAt = now + delay;
    await ctx.db.patch(row._id, {
      status: "retry_scheduled",
      attemptCount: attempt,
      lockedAt: undefined,
      leaseToken: undefined,
      nextAttemptAt,
      lastResponseStatus: args.responseStatus,
      lastErrorCode: args.errorCode,
      updatedAt: now,
    });
    await ctx.scheduler.runAt(nextAttemptAt, internal.outgoingWebhooks.wakeDelivery, {
      deliveryId: row._id,
    });
    return null;
  },
});

export const wakeDelivery = internalMutation({
  args: { deliveryId: v.id("outgoingWebhookDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.deliveryId);
    if (row && ["pending", "retry_scheduled", "delivering"].includes(row.status))
      await startDelivery(ctx, row._id);
    return null;
  },
});

export const runFanoutWorkflow = outgoingWebhookWorkflow.define({
  args: { eventId: v.id("outgoingWebhookEvents") },
  returns: v.number(),
  handler: async (step, args) => {
    const deliveries = await step.runMutation(internal.outgoingWebhooks.fanOutEvent, args);
    await step.runAction(internal.outgoingWebhookActions.dispatchInternalCallback, args, {
      retry: { maxAttempts: 4, initialBackoffMs: 1_000, base: 2 },
    });
    return deliveries;
  },
});
export const runDeliveryWorkflow = outgoingWebhookWorkflow.define({
  args: { deliveryId: v.id("outgoingWebhookDeliveries") },
  returns: v.null(),
  handler: async (step, args) => {
    const leaseToken = await step.runMutation(internal.outgoingWebhooks.claimDelivery, args);
    if (!leaseToken) return null;
    const result = await step.runAction(internal.outgoingWebhookActions.deliverWebhook, {
      ...args,
      leaseToken,
    });
    await step.runMutation(internal.outgoingWebhooks.finishDeliveryAttempt, {
      ...args,
      ...result,
      leaseToken,
    });
    return null;
  },
});

function scoped<T extends { tenantId: string }>(row: T | null, tenantId: string): T | null {
  return row?.tenantId === tenantId ? row : null;
}

export const listWearablesEventTypes = query({
  args: {},
  returns: v.any(),
  handler: async () => ({
    version: 1,
    eventTypes: [...WEARABLES_EVENT_TYPES],
    groups: [...EVENT_GROUPS],
  }),
});
export const listWebhookEvents = query({
  args: {
    tenantId: v.string(),
    userId: v.optional(v.string()),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_LIST_LIMIT);
    const rows = args.userId
      ? await ctx.db
          .query("outgoingWebhookEvents")
          .withIndex("by_tenant_user_time", (q) => {
            const scope = q.eq("tenantId", args.tenantId).eq("userId", args.userId);
            return args.before ? scope.lt("occurredAt", args.before) : scope;
          })
          .order("desc")
          .take(limit + 1)
      : await ctx.db
          .query("outgoingWebhookEvents")
          .withIndex("by_tenant_time", (q) => {
            const scope = q.eq("tenantId", args.tenantId);
            return args.before ? scope.lt("occurredAt", args.before) : scope;
          })
          .order("desc")
          .take(limit + 1);
    return {
      events: rows.slice(0, limit).map(({ payloadJson: _payload, ...row }) => row),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.occurredAt ?? null) : null,
    };
  },
});
export const listWebhookDeliveries = query({
  args: {
    tenantId: v.string(),
    endpointId: v.optional(v.id("outgoingWebhookEndpoints")),
    status: v.optional(outgoingWebhookDeliveryStatus),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_LIST_LIMIT);
    const endpointId = args.endpointId;
    const status = args.status;
    const rows = endpointId
      ? status
        ? await ctx.db
            .query("outgoingWebhookDeliveries")
            .withIndex("by_tenant_endpoint_status_time", (q) => {
              const scope = q
                .eq("tenantId", args.tenantId)
                .eq("endpointId", endpointId)
                .eq("status", status);
              return args.before ? scope.lt("createdAt", args.before) : scope;
            })
            .order("desc")
            .take(limit + 1)
        : await ctx.db
            .query("outgoingWebhookDeliveries")
            .withIndex("by_tenant_endpoint_time", (q) => {
              const scope = q.eq("tenantId", args.tenantId).eq("endpointId", endpointId);
              return args.before ? scope.lt("createdAt", args.before) : scope;
            })
            .order("desc")
            .take(limit + 1)
      : status
        ? await ctx.db
            .query("outgoingWebhookDeliveries")
            .withIndex("by_tenant_status_time", (q) => {
              const scope = q.eq("tenantId", args.tenantId).eq("status", status);
              return args.before ? scope.lt("createdAt", args.before) : scope;
            })
            .order("desc")
            .take(limit + 1)
        : await ctx.db
            .query("outgoingWebhookDeliveries")
            .withIndex("by_tenant_time", (q) => {
              const scope = q.eq("tenantId", args.tenantId);
              return args.before ? scope.lt("createdAt", args.before) : scope;
            })
            .order("desc")
            .take(limit + 1);
    return {
      deliveries: rows.slice(0, limit).map(({ payloadJson: _payload, ...row }) => row),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.createdAt ?? null) : null,
    };
  },
});
export const listWebhookAttempts = query({
  args: {
    tenantId: v.string(),
    deliveryId: v.id("outgoingWebhookDeliveries"),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const delivery = scoped(await ctx.db.get(args.deliveryId), args.tenantId);
    if (!delivery) return { attempts: [], nextCursor: null };
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_LIST_LIMIT);
    const rows = await ctx.db
      .query("outgoingWebhookAttempts")
      .withIndex("by_delivery_time", (q) => {
        const deliveryScope = q.eq("deliveryId", args.deliveryId);
        return args.before ? deliveryScope.lt("startedAt", args.before) : deliveryScope;
      })
      .order("desc")
      .take(limit + 1);
    return {
      attempts: rows.slice(0, limit),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.startedAt ?? null) : null,
    };
  },
});

export const retryWebhookDelivery = mutation({
  args: { tenantId: v.string(), deliveryId: v.id("outgoingWebhookDeliveries") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = scoped(await ctx.db.get(args.deliveryId), args.tenantId);
    if (!row || !["failed", "canceled"].includes(row.status))
      throw new Error("Delivery is not retryable");
    const event = await ctx.db.get(row.eventId);
    const endpoint = await ctx.db.get(row.endpointId);
    if (!event || event.expiresAt <= Date.now() || !endpoint || endpoint.status !== "active")
      throw new Error("Delivery event expired or endpoint inactive");
    await ctx.db.patch(row._id, {
      status: "pending",
      lockedAt: undefined,
      leaseToken: undefined,
      failedAt: undefined,
      lastErrorCode: undefined,
      updatedAt: Date.now(),
    });
    await startDelivery(ctx, row._id);
    return null;
  },
});

async function startRecoveryOperation(
  ctx: MutationCtx,
  args: {
    tenantId: string;
    endpointId: Id<"outgoingWebhookEndpoints">;
    kind: "recover_failed" | "replay_missing";
    since: number;
    until?: number;
  },
) {
  const endpoint = scoped(await ctx.db.get(args.endpointId), args.tenantId);
  if (!endpoint || endpoint.status !== "active") throw new Error("Active endpoint not found");
  const until = args.until ?? Date.now();
  if (until < args.since || until - args.since > DEFAULT_EVENT_RETENTION_MS) {
    throw new Error("Recovery window must be ordered and no longer than 30 days");
  }
  let active = await ctx.db
    .query("outgoingWebhookOperations")
    .withIndex("by_endpoint_status", (q) =>
      q.eq("endpointId", args.endpointId).eq("status", "pending"),
    )
    .first();
  active ??= await ctx.db
    .query("outgoingWebhookOperations")
    .withIndex("by_endpoint_status", (q) =>
      q.eq("endpointId", args.endpointId).eq("status", "running"),
    )
    .first();
  if (active) throw new Error("A recovery operation is already running for this endpoint");
  const now = Date.now();
  const operationId = await ctx.db.insert("outgoingWebhookOperations", {
    tenantId: args.tenantId,
    endpointId: args.endpointId,
    kind: args.kind,
    since: args.since,
    until,
    status: "pending",
    processed: 0,
    createdAt: now,
    updatedAt: now,
  });
  const workflowId = await outgoingWebhookWorkflow.start(
    ctx,
    internal.outgoingWebhooks.runRecoveryWorkflow,
    { operationId },
    {
      startAsync: true,
      onComplete: internal.outgoingWebhooks.handleRecoveryComplete,
      context: { operationId },
    },
  );
  await ctx.db.patch(operationId, { workflowId });
  return { operationId, workflowId };
}

export const recoverFailedWebhookDeliveries = mutation({
  args: { tenantId: v.string(), endpointId: v.id("outgoingWebhookEndpoints"), since: v.number() },
  returns: v.object({ operationId: v.id("outgoingWebhookOperations"), workflowId: v.string() }),
  handler: async (ctx, args) =>
    await startRecoveryOperation(ctx, { ...args, kind: "recover_failed" }),
});

export const replayMissingWebhookEvents = mutation({
  args: {
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    since: v.number(),
    until: v.optional(v.number()),
  },
  returns: v.object({ operationId: v.id("outgoingWebhookOperations"), workflowId: v.string() }),
  handler: async (ctx, args) =>
    await startRecoveryOperation(ctx, { ...args, kind: "replay_missing" }),
});

export const getWebhookRecoveryOperation = query({
  args: { tenantId: v.string(), operationId: v.id("outgoingWebhookOperations") },
  returns: v.any(),
  handler: async (ctx, args) => scoped(await ctx.db.get(args.operationId), args.tenantId),
});

export const processRecoveryOperation = internalMutation({
  args: { operationId: v.id("outgoingWebhookOperations") },
  returns: v.object({ done: v.boolean(), processed: v.number() }),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation || ["completed", "failed"].includes(operation.status)) {
      return { done: true, processed: 0 };
    }
    const endpoint = await ctx.db.get(operation.endpointId);
    if (!endpoint || endpoint.status !== "active") {
      await ctx.db.patch(operation._id, {
        status: "failed",
        errorCode: "endpoint_inactive",
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
      return { done: true, processed: 0 };
    }
    let processed = 0;
    if (operation.kind === "recover_failed") {
      const rows = await ctx.db
        .query("outgoingWebhookDeliveries")
        .withIndex("by_endpoint_status_time", (q) =>
          q.eq("endpointId", endpoint._id).eq("status", "failed").gte("createdAt", operation.since),
        )
        .take(MAX_RECOVERY_ROWS);
      for (const row of rows) {
        const event = await ctx.db.get(row.eventId);
        if (!event || event.expiresAt <= Date.now()) {
          await ctx.db.patch(row._id, {
            status: "canceled",
            lastErrorCode: "event_expired",
            updatedAt: Date.now(),
          });
          continue;
        }
        await ctx.db.patch(row._id, {
          status: "pending",
          lockedAt: undefined,
          leaseToken: undefined,
          failedAt: undefined,
          updatedAt: Date.now(),
        });
        await startDelivery(ctx, row._id);
        processed++;
      }
      const done = rows.length < MAX_RECOVERY_ROWS;
      await ctx.db.patch(operation._id, {
        status: done ? "completed" : "running",
        processed: operation.processed + processed,
        updatedAt: Date.now(),
        completedAt: done ? Date.now() : undefined,
      });
      return { done, processed };
    } else {
      const page = await ctx.db
        .query("outgoingWebhookEvents")
        .withIndex("by_tenant_time", (q) =>
          q
            .eq("tenantId", operation.tenantId)
            .gte("occurredAt", operation.since)
            .lte("occurredAt", operation.until ?? Date.now()),
        )
        .paginate({ cursor: operation.cursor ?? null, numItems: MAX_RECOVERY_ROWS });
      for (const event of page.page) {
        if (endpoint.scope === "user" && endpoint.userId !== event.userId) continue;
        if (!endpoint.eventTypes.includes(event.eventType)) continue;
        const existing = await ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_event_endpoint", (q) =>
            q.eq("eventId", event._id).eq("endpointId", endpoint._id),
          )
          .first();
        if (existing) continue;
        const now = Date.now();
        const deliveryId = await ctx.db.insert("outgoingWebhookDeliveries", {
          eventId: event._id,
          endpointId: endpoint._id,
          tenantId: operation.tenantId,
          userId: event.userId,
          provider: event.provider,
          payloadJson:
            endpoint.payloadMode === "snapshot"
              ? event.payloadJson
              : (event.referencePayloadJson ?? event.payloadJson),
          status: "pending",
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        });
        await startDelivery(ctx, deliveryId);
        processed++;
      }
      const total = operation.processed + processed;
      await ctx.db.patch(operation._id, {
        status: page.isDone ? "completed" : "running",
        cursor: page.isDone ? undefined : page.continueCursor,
        processed: total,
        updatedAt: Date.now(),
        completedAt: page.isDone ? Date.now() : undefined,
      });
      return { done: page.isDone, processed };
    }
  },
});

export const runRecoveryWorkflow = outgoingWebhookWorkflow.define({
  args: { operationId: v.id("outgoingWebhookOperations") },
  returns: v.number(),
  handler: async (step, args) => {
    let processed = 0;
    while (true) {
      const result = await step.runMutation(
        internal.outgoingWebhooks.processRecoveryOperation,
        args,
      );
      processed += result.processed;
      if (result.done) return processed;
    }
  },
});

export const handleRecoveryComplete = internalMutation({
  args: {
    workflowId: v.string(),
    result: v.any(),
    context: v.object({ operationId: v.id("outgoingWebhookOperations") }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.context.operationId);
    if (!operation || operation.status === "completed") return null;
    if (args.result.kind !== "success") {
      await ctx.db.patch(operation._id, {
        workflowId: args.workflowId,
        status: "failed",
        errorCode: args.result.kind === "canceled" ? "operation_canceled" : "operation_failed",
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
    }
    return null;
  },
});

export const emitTestEvent = internalMutation({
  args: {
    tenantId: v.string(),
    endpointId: v.id("outgoingWebhookEndpoints"),
    eventType: v.string(),
  },
  returns: v.id("outgoingWebhookDeliveries"),
  handler: async (ctx, args) => {
    const endpoint = scoped(await ctx.db.get(args.endpointId), args.tenantId);
    if (!endpoint || endpoint.status !== "active") {
      throw new Error("Active webhook endpoint not found");
    }
    const expanded = expandEventTypes([args.eventType]);
    if (expanded.length !== 1 || expanded[0] !== args.eventType) {
      throw new Error("Test events require one exact supported event type");
    }
    const now = Date.now();
    const id = crypto.randomUUID();
    const eventId = await ctx.db.insert("outgoingWebhookEvents", {
      eventPublicId: id,
      tenantId: args.tenantId,
      userId: endpoint.userId,
      eventType: args.eventType,
      eventVersion: 1,
      subjectKind: "connection",
      idempotencyKey: `test:${id}`,
      payloadJson: canonicalJson({
        id,
        type: args.eventType,
        version: 1,
        occurredAt: now,
        tenantId: args.tenantId,
        userId: endpoint.userId,
        subject: { kind: "connection" },
        idempotencyKey: `test:${id}`,
        data: { test: true },
      }),
      referencePayloadJson: canonicalJson({
        id,
        type: args.eventType,
        version: 1,
        occurredAt: now,
        tenantId: args.tenantId,
        userId: endpoint.userId,
        subject: { kind: "connection" },
        idempotencyKey: `test:${id}`,
        data: { test: true },
      }),
      occurredAt: now,
      fanoutStatus: "completed",
      expiresAt: now + DEFAULT_EVENT_RETENTION_MS,
    });
    const deliveryId = await ctx.db.insert("outgoingWebhookDeliveries", {
      eventId,
      endpointId: endpoint._id,
      tenantId: args.tenantId,
      userId: endpoint.userId,
      payloadJson: canonicalJson({
        id,
        type: args.eventType,
        version: 1,
        occurredAt: now,
        tenantId: args.tenantId,
        userId: endpoint.userId,
        subject: { kind: "connection" },
        idempotencyKey: `test:${id}`,
        data: { test: true },
      }),
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await startDelivery(ctx, deliveryId);
    return deliveryId;
  },
});

export const cleanupExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    let deleted = 0;
    const attempts = await ctx.db
      .query("outgoingWebhookAttempts")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", now))
      .take(100);
    for (const row of attempts) {
      await ctx.db.delete(row._id);
      deleted++;
    }
    const events = await ctx.db
      .query("outgoingWebhookEvents")
      .withIndex("by_expiry", (q) => q.lte("expiresAt", now))
      .take(100);
    for (const event of events) {
      const deliveries = await ctx.db
        .query("outgoingWebhookDeliveries")
        .withIndex("by_event_endpoint", (q) => q.eq("eventId", event._id))
        .collect();
      for (const delivery of deliveries) {
        const history = await ctx.db
          .query("outgoingWebhookAttempts")
          .withIndex("by_delivery_time", (q) => q.eq("deliveryId", delivery._id))
          .collect();
        for (const row of history) await ctx.db.delete(row._id);
        await ctx.db.delete(delivery._id);
      }
      await ctx.db.delete(event._id);
      deleted++;
    }
    return deleted;
  },
});

export const deleteUserOutgoingState = internalMutation({
  args: { userId: v.string(), provider: v.optional(providerName), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const mapping = await ctx.db
      .query("outgoingWebhookUserTenants")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (!mapping) return 0;
    const events = await ctx.db
      .query("outgoingWebhookEvents")
      .withIndex("by_tenant_user_time", (q) =>
        q.eq("tenantId", mapping.tenantId).eq("userId", args.userId),
      )
      .take(Math.min(args.limit ?? 100, 100));
    let deleted = 0;
    for (const event of events) {
      if (args.provider && event.provider !== args.provider) continue;
      const deliveries = await ctx.db
        .query("outgoingWebhookDeliveries")
        .withIndex("by_event_endpoint", (q) => q.eq("eventId", event._id))
        .collect();
      for (const delivery of deliveries) {
        const attempts = await ctx.db
          .query("outgoingWebhookAttempts")
          .withIndex("by_delivery_time", (q) => q.eq("deliveryId", delivery._id))
          .collect();
        for (const attempt of attempts) await ctx.db.delete(attempt._id);
        await ctx.db.delete(delivery._id);
      }
      await ctx.db.delete(event._id);
      deleted++;
    }
    if (!args.provider) {
      const endpoints = await ctx.db
        .query("outgoingWebhookEndpoints")
        .withIndex("by_tenant_user_status", (q) =>
          q.eq("tenantId", mapping.tenantId).eq("userId", args.userId),
        )
        .collect();
      for (const endpoint of endpoints)
        await ctx.db.patch(endpoint._id, {
          status: "deleted",
          encryptedSigningSecret: "deleted",
          previousEncryptedSigningSecret: undefined,
          previousSecretValidUntil: undefined,
          url: "https://deleted.invalid/",
          description: undefined,
          eventTypes: [],
          updatedAt: Date.now(),
        });
      if (events.length < Math.min(args.limit ?? 100, 100)) await ctx.db.delete(mapping._id);
    }
    return deleted;
  },
});
