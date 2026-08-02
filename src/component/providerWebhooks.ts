/**
 * Durable inbound provider webhooks for WHOOP v2, Polar AccessLink, and Suunto.
 *
 * HTTP routes call `acceptProviderWebhook` with the exact request body and
 * signature headers. Verification happens before the transactional receipt +
 * workflow start mutation. Provider API calls and normalized writes happen in
 * the dedicated webhook workflow after the provider has been acknowledged.
 */

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { isProviderApiError } from "./providers/oauth";
import { fetchPolarExerciseById } from "./providers/polar";
import {
  fetchSuuntoWorkoutById,
  normalizeSuuntoActivitySample,
  normalizeSuuntoRecoverySample,
  normalizeSuuntoSleep,
} from "./providers/suunto";
import type { NormalizedDataPoint, NormalizedEvent } from "./providers/types";
import {
  fetchWhoopRecoveryById,
  fetchWhoopSleepById,
  fetchWhoopWorkoutById,
} from "./providers/whoop";
import {
  liveWebhookProvider,
  providerWebhookReceiptStatus,
  providerWebhookRegistrationStatus,
} from "./schema";
import { providerWebhookWorkflow } from "./workflowManager";

const MAX_BODY_BYTES = 512_000;
const MAX_SUUNTO_SAMPLES = 5_000;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CONNECTION_RACE_TTL_MS = 15 * 60 * 1_000;
const CONNECTION_RETRY_MS = 60 * 1_000;
const WHOOP_REPLAY_WINDOW_MS = 5 * 60 * 1_000;
const CLEANUP_BATCH_SIZE = 100;
const POLAR_API_BASE = "https://www.polaraccesslink.com";
const POLAR_SUPPORTED_EVENTS = ["EXERCISE"] as const;
const WHOOP_EVENT_TYPES = new Set([
  "workout.updated",
  "workout.deleted",
  "sleep.updated",
  "sleep.deleted",
  "recovery.updated",
  "recovery.deleted",
]);
const SUUNTO_EVENT_TYPES = new Set([
  "WORKOUT_CREATED",
  "SUUNTO_247_SLEEP_CREATED",
  "SUUNTO_247_ACTIVITY_CREATED",
  "SUUNTO_247_RECOVERY_CREATED",
  "ROUTE_CREATED",
]);

type LiveWebhookProvider = "polar" | "whoop" | "suunto";
type Notification = {
  eventType: string;
  providerUserId?: string;
  providerUsername?: string;
  resourceId?: string;
  traceId?: string;
  supported: boolean;
};

export class ProviderWebhookRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProviderWebhookRequestError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ProviderWebhookRequestError(400, "invalid_body_encoding", "Invalid body encoding");
  }
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function hmacSha256(secret: string, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

async function sha256Hex(message: Uint8Array): Promise<string> {
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", message)));
}

export async function createProviderWebhookSignature(args: {
  provider: LiveWebhookProvider;
  secret: string;
  rawBody: string;
  rawBodyBytes?: Uint8Array;
  timestamp?: string;
}): Promise<string> {
  const body = args.rawBodyBytes ?? new TextEncoder().encode(args.rawBody);
  const message =
    args.provider === "whoop"
      ? concatenateBytes(new TextEncoder().encode(args.timestamp ?? ""), body)
      : body;
  const digest = await hmacSha256(args.secret, message);
  return args.provider === "whoop" ? encodeBase64(digest) : encodeHex(digest);
}

function parseNotification(provider: LiveWebhookProvider, payload: unknown): Notification {
  if (!isRecord(payload)) {
    throw new ProviderWebhookRequestError(400, "invalid_envelope", "Expected a JSON object");
  }

  if (provider === "whoop") {
    const eventType = stringField(payload.type);
    const providerUserId =
      typeof payload.user_id === "number" && Number.isFinite(payload.user_id)
        ? String(payload.user_id)
        : stringField(payload.user_id);
    const resourceId = stringField(payload.id);
    if (!eventType || !providerUserId || !resourceId) {
      throw new ProviderWebhookRequestError(400, "invalid_envelope", "Invalid WHOOP v2 payload");
    }
    return {
      eventType,
      providerUserId,
      resourceId,
      traceId: stringField(payload.trace_id),
      supported: WHOOP_EVENT_TYPES.has(eventType),
    };
  }

  if (provider === "polar") {
    const eventType = stringField(payload.event);
    if (!eventType) {
      throw new ProviderWebhookRequestError(400, "invalid_envelope", "Invalid Polar payload");
    }
    if (eventType === "PING") {
      return { eventType, supported: true };
    }
    const user = payload.user_id;
    const entity = payload.entity_id;
    const providerUserId =
      typeof user === "number" && Number.isFinite(user) ? String(user) : stringField(user);
    const resourceId =
      typeof entity === "number" && Number.isFinite(entity) ? String(entity) : stringField(entity);
    if (!providerUserId || !resourceId || !stringField(payload.timestamp)) {
      throw new ProviderWebhookRequestError(400, "invalid_envelope", "Invalid Polar event");
    }
    return {
      eventType,
      providerUserId,
      resourceId,
      supported: POLAR_SUPPORTED_EVENTS.includes(
        eventType as (typeof POLAR_SUPPORTED_EVENTS)[number],
      ),
    };
  }

  const eventType = stringField(payload.type);
  const providerUsername = stringField(payload.username);
  if (!eventType || !providerUsername) {
    throw new ProviderWebhookRequestError(400, "invalid_envelope", "Invalid Suunto payload");
  }
  const samples = payload.samples;
  if (samples !== undefined && !Array.isArray(samples)) {
    throw new ProviderWebhookRequestError(
      400,
      "invalid_samples",
      "Suunto samples must be an array",
    );
  }
  if (Array.isArray(samples) && samples.length > MAX_SUUNTO_SAMPLES) {
    throw new ProviderWebhookRequestError(413, "too_many_samples", "Suunto sample limit exceeded");
  }
  const workout = isRecord(payload.workout) ? payload.workout : undefined;
  const resourceId = stringField(workout?.workoutKey) ?? stringField(workout?.workoutId);
  if (eventType === "WORKOUT_CREATED" && !resourceId) {
    throw new ProviderWebhookRequestError(400, "invalid_envelope", "Missing Suunto workout key");
  }
  return {
    eventType,
    providerUsername,
    resourceId,
    supported: SUUNTO_EVENT_TYPES.has(eventType),
  };
}

/** Testable contract parser; provider-specific payload unions remain private. */
export function parseNotificationForTest(
  provider: LiveWebhookProvider,
  payload: unknown,
): Notification {
  return parseNotification(provider, payload);
}

function deriveIdempotencyKey(
  provider: LiveWebhookProvider,
  notification: Notification,
  payload: Record<string, unknown>,
  digest: string,
): string {
  if (provider === "whoop" && notification.traceId) return `whoop:v2:${notification.traceId}`;
  if (provider === "polar") {
    return `polar:${notification.eventType}:${notification.providerUserId}:${notification.resourceId}:${String(payload.timestamp)}`;
  }
  if (provider === "suunto" && notification.eventType === "WORKOUT_CREATED") {
    return `suunto:${notification.eventType}:${notification.providerUsername}:${notification.resourceId}`;
  }
  return `${provider}:${notification.eventType}:${notification.providerUserId ?? notification.providerUsername}:${notification.resourceId ?? ""}:${digest}`;
}

async function verifySignature(args: {
  provider: LiveWebhookProvider;
  secret: string;
  rawBody: string;
  rawBodyBytes: Uint8Array;
  signature?: string;
  signatureTimestamp?: string;
  now: number;
}): Promise<void> {
  if (!args.signature) {
    throw new ProviderWebhookRequestError(401, "missing_signature", "Missing webhook signature");
  }
  if (args.provider === "whoop") {
    if (!args.signatureTimestamp) {
      throw new ProviderWebhookRequestError(401, "missing_timestamp", "Missing WHOOP timestamp");
    }
    const timestamp = Number(args.signatureTimestamp);
    const timestampMs = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
    if (
      !Number.isFinite(timestampMs) ||
      Math.abs(args.now - timestampMs) > WHOOP_REPLAY_WINDOW_MS
    ) {
      throw new ProviderWebhookRequestError(403, "stale_signature", "WHOOP signature is stale");
    }
  }
  const expected = await createProviderWebhookSignature({
    provider: args.provider,
    secret: args.secret,
    rawBody: args.rawBody,
    rawBodyBytes: args.rawBodyBytes,
    timestamp: args.signatureTimestamp,
  });
  const provided = args.signature.trim().replace(/^sha256=/i, "");
  const valid =
    args.provider === "whoop"
      ? constantTimeEquals(provided, expected)
      : constantTimeEquals(provided.toLowerCase(), expected.toLowerCase());
  if (!valid) {
    throw new ProviderWebhookRequestError(403, "invalid_signature", "Invalid webhook signature");
  }
}

function safeReceipt(receipt: Doc<"providerWebhookReceipts">) {
  const { payloadJson: _payloadJson, ...safe } = receipt;
  return safe;
}

export const getVerificationSettings = internalQuery({
  args: { provider: liveWebhookProvider },
  returns: v.any(),
  handler: async (ctx, args) => {
    const registration = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();
    const settings = await ctx.db
      .query("providerSettings")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();
    return {
      secret: args.provider === "whoop" ? settings?.clientSecret : registration?.webhookSecret,
      registration,
      credentials:
        settings?.clientId && settings.clientSecret
          ? {
              clientId: settings.clientId,
              clientSecret: settings.clientSecret,
              subscriptionKey: settings.subscriptionKey,
            }
          : null,
    };
  },
});

export const markRegistrationVerified = internalMutation({
  args: { provider: liveWebhookProvider },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { lastVerifiedAt: Date.now(), updatedAt: Date.now() });
    }
  },
});

export const acceptProviderWebhook = action({
  args: {
    provider: liveWebhookProvider,
    rawBody: v.optional(v.string()),
    rawBodyBase64: v.optional(v.string()),
    signature: v.optional(v.string()),
    signatureTimestamp: v.optional(v.string()),
    eventHeader: v.optional(v.string()),
    maxBodyBytes: v.optional(v.number()),
  },
  returns: v.object({
    accepted: v.boolean(),
    duplicate: v.boolean(),
    ping: v.boolean(),
    receiptId: v.optional(v.string()),
    statusCode: v.optional(v.number()),
    errorCode: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    try {
      if ((args.rawBody === undefined) === (args.rawBodyBase64 === undefined)) {
        throw new ProviderWebhookRequestError(
          400,
          "invalid_body_encoding",
          "Provide exactly one raw body representation",
        );
      }
      const bytes =
        args.rawBodyBase64 !== undefined
          ? decodeBase64(args.rawBodyBase64)
          : new TextEncoder().encode(args.rawBody ?? "");
      let rawBody: string;
      try {
        rawBody = args.rawBody ?? new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new ProviderWebhookRequestError(400, "invalid_body_encoding", "Body is not UTF-8");
      }
      const maxBodyBytes = Math.min(Math.max(args.maxBodyBytes ?? MAX_BODY_BYTES, 1), 1_000_000);
      if (bytes.byteLength > maxBodyBytes) {
        throw new ProviderWebhookRequestError(
          413,
          "payload_too_large",
          "Webhook body exceeds limit",
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        throw new ProviderWebhookRequestError(400, "invalid_json", "Invalid JSON body");
      }
      const notification = parseNotification(args.provider, payload);
      if (args.provider === "polar" && notification.eventType === "PING") {
        if (!isRecord(payload) || Object.keys(payload).some((key) => key !== "event")) {
          throw new ProviderWebhookRequestError(400, "invalid_ping", "Invalid Polar PING");
        }
        await ctx.runMutation(internal.providerWebhooks.markRegistrationVerified, {
          provider: "polar",
        });
        return { accepted: true, duplicate: false, ping: true };
      }

      const verification = await ctx.runQuery(internal.providerWebhooks.getVerificationSettings, {
        provider: args.provider,
      });
      if (!verification?.secret) {
        throw new ProviderWebhookRequestError(
          503,
          "secret_not_configured",
          "Webhook is not configured",
        );
      }
      await verifySignature({
        provider: args.provider,
        secret: verification.secret,
        rawBody,
        rawBodyBytes: bytes,
        signature: args.signature,
        signatureTimestamp: args.signatureTimestamp,
        now: Date.now(),
      });
      if (
        args.provider === "polar" &&
        args.eventHeader &&
        args.eventHeader.toUpperCase() !== notification.eventType.toUpperCase()
      ) {
        throw new ProviderWebhookRequestError(400, "event_mismatch", "Polar event header mismatch");
      }

      const digest = await sha256Hex(bytes);
      const idempotencyKey = deriveIdempotencyKey(
        args.provider,
        notification,
        payload as Record<string, unknown>,
        digest,
      );
      const accepted = await ctx.runMutation(internal.providerWebhooks.acceptReceipt, {
        provider: args.provider,
        idempotencyKey,
        eventType: notification.eventType,
        providerUserId: notification.providerUserId,
        providerUsername: notification.providerUsername,
        resourceId: notification.resourceId,
        providerTraceId: notification.traceId,
        payloadJson: rawBody,
        payloadDigest: digest,
        supported: notification.supported,
      });
      return { ...accepted, ping: false };
    } catch (error) {
      if (error instanceof ProviderWebhookRequestError) {
        return {
          accepted: false,
          duplicate: false,
          ping: false,
          statusCode: error.status,
          errorCode: error.code,
        };
      }
      throw error;
    }
  },
});

export const acceptReceipt = internalMutation({
  args: {
    provider: liveWebhookProvider,
    idempotencyKey: v.string(),
    eventType: v.string(),
    providerUserId: v.optional(v.string()),
    providerUsername: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    providerTraceId: v.optional(v.string()),
    payloadJson: v.string(),
    payloadDigest: v.string(),
    supported: v.boolean(),
  },
  returns: v.object({
    accepted: v.boolean(),
    duplicate: v.boolean(),
    receiptId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerWebhookReceipts")
      .withIndex("by_provider_idempotency", (idx) =>
        idx.eq("provider", args.provider).eq("idempotencyKey", args.idempotencyKey),
      )
      .first();
    if (existing) {
      return { accepted: true, duplicate: true, receiptId: existing._id };
    }
    const now = Date.now();
    const receiptId = await ctx.db.insert("providerWebhookReceipts", {
      provider: args.provider,
      idempotencyKey: args.idempotencyKey,
      eventType: args.eventType,
      providerUserId: args.providerUserId,
      providerUsername: args.providerUsername,
      resourceId: args.resourceId,
      providerTraceId: args.providerTraceId,
      payloadJson: args.payloadJson,
      payloadDigest: args.payloadDigest,
      receivedAt: now,
      expiresAt: now + RECEIPT_TTL_MS,
      status: args.supported ? "pending" : "ignored",
      attempt: 0,
      resultCode: args.supported ? undefined : "unsupported_event",
      completedAt: args.supported ? undefined : now,
    });
    await ctx.scheduler.runAt(
      now + RECEIPT_TTL_MS,
      internal.providerWebhooks.cleanupExpiredProviderWebhookReceipt,
      { receiptId },
    );
    if (!args.supported) {
      await ctx.db.patch(receiptId, { payloadJson: "{}" });
      return { accepted: true, duplicate: false, receiptId };
    }
    const workflowId = await providerWebhookWorkflow.start(
      ctx,
      internal.providerWebhooks.runProviderWebhook,
      { receiptId },
      {
        startAsync: true,
        onComplete: internal.providerWebhooks.handleProviderWebhookComplete,
        context: { receiptId },
      },
    );
    await ctx.db.patch(receiptId, { workflowId });
    return { accepted: true, duplicate: false, receiptId };
  },
});

export const getReceiptInternal = internalQuery({
  args: { receiptId: v.id("providerWebhookReceipts") },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.get(args.receiptId),
});

export const markProcessing = internalMutation({
  args: { receiptId: v.id("providerWebhookReceipts") },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.status === "canceled") return;
    await ctx.db.patch(receipt._id, { status: "processing", attempt: receipt.attempt + 1 });
  },
});

export const markWaitingForConnection = internalMutation({
  args: { receiptId: v.id("providerWebhookReceipts") },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.status === "canceled") return;
    const expiresAt = Math.min(receipt.expiresAt, receipt.receivedAt + CONNECTION_RACE_TTL_MS);
    if (Date.now() >= expiresAt) {
      await ctx.db.patch(receipt._id, {
        status: "ignored",
        resultCode: "connection_not_found",
        completedAt: Date.now(),
        expiresAt,
        payloadJson: "{}",
      });
      return;
    }
    await ctx.db.patch(receipt._id, { status: "waiting_for_connection", expiresAt });
    await ctx.scheduler.runAt(
      expiresAt,
      internal.providerWebhooks.cleanupExpiredProviderWebhookReceipt,
      { receiptId: receipt._id },
    );
    await ctx.scheduler.runAfter(
      CONNECTION_RETRY_MS,
      internal.providerWebhooks.retryWaitingReceipt,
      {
        receiptId: receipt._id,
      },
    );
  },
});

export const retryWaitingReceipt = internalMutation({
  args: { receiptId: v.id("providerWebhookReceipts") },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt || receipt.status !== "waiting_for_connection") return;
    if (Date.now() >= receipt.expiresAt) {
      await ctx.db.patch(receipt._id, {
        status: "ignored",
        resultCode: "connection_not_found",
        completedAt: Date.now(),
        payloadJson: "{}",
      });
      return;
    }
    const workflowId = await providerWebhookWorkflow.start(
      ctx,
      internal.providerWebhooks.runProviderWebhook,
      { receiptId: receipt._id },
      {
        startAsync: true,
        onComplete: internal.providerWebhooks.handleProviderWebhookComplete,
        context: { receiptId: receipt._id },
      },
    );
    await ctx.db.patch(receipt._id, { status: "pending", workflowId });
  },
});

async function ensureSource(
  ctx: Pick<ActionCtx, "runMutation">,
  connection: Doc<"connections">,
): Promise<Id<"dataSources">> {
  return await ctx.runMutation(api.dataSources.getOrCreate, {
    userId: connection.userId,
    provider: connection.provider,
    connectionId: connection._id,
    source: connection.provider,
  });
}

async function storeEvent(
  ctx: Pick<ActionCtx, "runMutation">,
  connection: Doc<"connections">,
  event: NormalizedEvent,
): Promise<void> {
  const dataSourceId = await ensureSource(ctx, connection);
  await ctx.runMutation(internal.events.storeEvent, {
    dataSourceId,
    userId: connection.userId,
    category: event.category,
    type: event.type,
    sourceName: event.sourceName,
    durationSeconds: event.durationSeconds,
    startDatetime: event.startDatetime,
    endDatetime: event.endDatetime,
    externalId: event.externalId,
    heartRateMin: event.heartRateMin,
    heartRateMax: event.heartRateMax,
    heartRateAvg: event.heartRateAvg,
    energyBurned: event.energyBurned,
    distance: event.distance,
    stepsCount: event.stepsCount,
    maxSpeed: event.maxSpeed,
    maxWatts: event.maxWatts,
    movingTimeSeconds: event.movingTimeSeconds,
    totalElevationGain: event.totalElevationGain,
    averageSpeed: event.averageSpeed,
    averageWatts: event.averageWatts,
    elevHigh: event.elevHigh,
    elevLow: event.elevLow,
    sleepTotalDurationMinutes: event.sleepTotalDurationMinutes,
    sleepTimeInBedMinutes: event.sleepTimeInBedMinutes,
    sleepEfficiencyScore: event.sleepEfficiencyScore,
    sleepDeepMinutes: event.sleepDeepMinutes,
    sleepRemMinutes: event.sleepRemMinutes,
    sleepLightMinutes: event.sleepLightMinutes,
    sleepAwakeMinutes: event.sleepAwakeMinutes,
    isNap: event.isNap,
    sleepStages: event.sleepStages,
  });
}

async function storePoints(
  ctx: Pick<ActionCtx, "runMutation">,
  connection: Doc<"connections">,
  points: NormalizedDataPoint[],
): Promise<number> {
  if (points.length === 0) return 0;
  const dataSourceId = await ensureSource(ctx, connection);
  const groups = new Map<string, NormalizedDataPoint[]>();
  for (const point of points) {
    const group = groups.get(point.seriesType) ?? [];
    group.push(point);
    groups.set(point.seriesType, group);
  }
  let stored = 0;
  for (const [seriesType, group] of groups) {
    stored += await ctx.runMutation(internal.dataPoints.storeBatch, {
      dataSourceId,
      seriesType,
      points: group.map(({ recordedAt, value, externalId }) => ({ recordedAt, value, externalId })),
    });
  }
  return stored;
}

async function upsertRecoverySummaries(
  ctx: Pick<ActionCtx, "runMutation">,
  connection: Doc<"connections">,
  points: NormalizedDataPoint[],
): Promise<void> {
  const byDate = new Map<string, NormalizedDataPoint[]>();
  for (const point of points) {
    const date = new Date(point.recordedAt).toISOString().slice(0, 10);
    const rows = byDate.get(date) ?? [];
    rows.push(point);
    byDate.set(date, rows);
  }
  const average = (rows: NormalizedDataPoint[], seriesType: string) => {
    const values = rows.filter((row) => row.seriesType === seriesType).map((row) => row.value);
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : undefined;
  };
  for (const [date, rows] of byDate) {
    await ctx.runMutation(internal.summaries.upsert, {
      userId: connection.userId,
      provider: connection.provider,
      source: connection.provider,
      date,
      category: "recovery",
      recoveryScore: average(rows, "recovery_score"),
      restingHeartRate: average(rows, "resting_heart_rate"),
      hrvRmssd: average(rows, "heart_rate_variability_rmssd"),
      spo2Avg: average(rows, "oxygen_saturation"),
      bodyTemperature: average(rows, "skin_temperature"),
    });
  }
}

export const deleteExactResource = internalMutation({
  args: {
    connectionId: v.id("connections"),
    category: v.union(v.literal("workout"), v.literal("sleep"), v.literal("recovery")),
    externalId: v.string(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) return 0;
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_connection", (idx) => idx.eq("connectionId", connection._id))
      .collect();
    const sourceIds = new Set(sources.map((source) => source._id));
    let deleted = 0;
    if (args.category !== "recovery") {
      const candidates = await ctx.db
        .query("events")
        .withIndex("by_external_id", (idx) => idx.eq("externalId", args.externalId))
        .collect();
      const event = candidates.find(
        (candidate) =>
          candidate.userId === connection.userId &&
          candidate.category === args.category &&
          sourceIds.has(candidate.dataSourceId),
      );
      if (event) {
        const segments = await ctx.db
          .query("workoutSegments")
          .withIndex("by_event_kind_index", (idx) => idx.eq("eventId", event._id))
          .collect();
        const zones = await ctx.db
          .query("workoutZones")
          .withIndex("by_event_kind_zone", (idx) => idx.eq("eventId", event._id))
          .collect();
        for (const child of [...segments, ...zones]) await ctx.db.delete(child._id);
        await ctx.db.delete(event._id);
        deleted += 1;
      }
      return deleted;
    }
    const affectedDates = new Set<string>();
    for (const source of sources) {
      const points = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_time", (idx) => idx.eq("dataSourceId", source._id))
        .collect();
      for (const point of points) {
        if (point.externalId?.startsWith(args.externalId)) {
          affectedDates.add(new Date(point.recordedAt).toISOString().slice(0, 10));
          await ctx.db.delete(point._id);
          deleted += 1;
        }
      }
    }
    for (const date of affectedDates) {
      const dayStart = Date.parse(`${date}T00:00:00.000Z`);
      const dayEnd = dayStart + 24 * 60 * 60 * 1_000;
      const remaining = [] as Array<{ seriesType: string; value: number }>;
      for (const source of sources) {
        remaining.push(
          ...(await ctx.db
            .query("dataPoints")
            .withIndex("by_source_time", (idx) =>
              idx
                .eq("dataSourceId", source._id)
                .gte("recordedAt", dayStart)
                .lt("recordedAt", dayEnd),
            )
            .collect()),
        );
      }
      const summary = await ctx.db
        .query("dailySummaries")
        .withIndex("by_user_provider_category_date", (idx) =>
          idx
            .eq("userId", connection.userId)
            .eq("provider", connection.provider)
            .eq("category", "recovery")
            .eq("date", date),
        )
        .first();
      if (remaining.length === 0) {
        if (summary) await ctx.db.delete(summary._id);
        continue;
      }
      const average = (seriesType: string) => {
        const values = remaining
          .filter((point) => point.seriesType === seriesType)
          .map((point) => point.value);
        return values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : undefined;
      };
      const metrics = {
        recoveryScore: average("recovery_score"),
        restingHeartRate: average("resting_heart_rate"),
        hrvRmssd: average("heart_rate_variability_rmssd"),
        spo2Avg: average("oxygen_saturation"),
        bodyTemperature: average("skin_temperature"),
      };
      if (summary) await ctx.db.patch(summary._id, metrics);
      else {
        await ctx.db.insert("dailySummaries", {
          userId: connection.userId,
          provider: connection.provider,
          source: connection.provider,
          date,
          category: "recovery",
          ...metrics,
        });
      }
    }
    return deleted;
  },
});

export const processReceipt = internalAction({
  args: { receiptId: v.id("providerWebhookReceipts") },
  returns: v.object({ code: v.string(), records: v.number() }),
  handler: async (ctx, args) => {
    try {
      const receipt = await ctx.runQuery(internal.providerWebhooks.getReceiptInternal, args);
      if (!receipt || receipt.status === "canceled") return { code: "canceled", records: 0 };
      const connection = receipt.providerUserId
        ? await ctx.runQuery(internal.connections.getByProviderUser, {
            provider: receipt.provider,
            providerUserId: receipt.providerUserId,
          })
        : await ctx.runQuery(internal.connections.getByProviderUsername, {
            provider: receipt.provider,
            providerUsername: receipt.providerUsername ?? "",
          });
      if (!connection) {
        await ctx.runMutation(internal.providerWebhooks.markWaitingForConnection, args);
        return { code: "waiting_for_connection", records: 0 };
      }
      if (connection.status !== "active") return { code: "connection_inactive", records: 0 };

      await ctx.runMutation(internal.providerWebhooks.attachConnection, {
        receiptId: receipt._id,
        connectionId: connection._id,
      });
      const settings = await ctx.runQuery(internal.providerWebhooks.getVerificationSettings, {
        provider: receipt.provider,
      });
      if (!settings?.credentials) throw new Error(`Missing ${receipt.provider} credentials`);
      const accessToken = await ctx.runAction(internal.oauthActions.ensureValidToken, {
        connectionId: connection._id,
        provider: connection.provider,
        accessToken: connection.accessToken ?? "",
        refreshToken: connection.refreshToken,
        tokenExpiresAt: connection.tokenExpiresAt,
        ...settings.credentials,
      });

      if (receipt.provider === "whoop") {
        const [category, operation] = receipt.eventType.split(".") as [
          "workout" | "sleep" | "recovery",
          "updated" | "deleted",
        ];
        const resourceId = receipt.resourceId ?? "";
        if (operation === "deleted") {
          const prefix =
            category === "workout"
              ? `whoop-workout-${resourceId}`
              : category === "sleep"
                ? `whoop-sleep-${resourceId}`
                : `whoop-recovery-${resourceId}-`;
          const records = await ctx.runMutation(internal.providerWebhooks.deleteExactResource, {
            connectionId: connection._id,
            category,
            externalId: prefix,
          });
          return { code: "deleted", records };
        }
        if (category === "workout") {
          await storeEvent(ctx, connection, await fetchWhoopWorkoutById(accessToken, resourceId));
          return { code: "upserted", records: 1 };
        }
        if (category === "sleep") {
          await storeEvent(ctx, connection, await fetchWhoopSleepById(accessToken, resourceId));
          return { code: "upserted", records: 1 };
        }
        const points = await fetchWhoopRecoveryById(accessToken, resourceId);
        const records = await storePoints(ctx, connection, points);
        await upsertRecoverySummaries(ctx, connection, points);
        return { code: "upserted", records };
      }

      if (receipt.provider === "polar") {
        if (receipt.eventType !== "EXERCISE") return { code: "unsupported_event", records: 0 };
        const event = await fetchPolarExerciseById(accessToken, receipt.resourceId ?? "");
        await storeEvent(ctx, connection, event);
        return { code: "upserted", records: 1 };
      }

      const payload = JSON.parse(receipt.payloadJson) as Record<string, unknown>;
      if (receipt.eventType === "ROUTE_CREATED") return { code: "unsupported_route", records: 0 };
      if (receipt.eventType === "WORKOUT_CREATED") {
        const event = await fetchSuuntoWorkoutById(
          accessToken,
          receipt.resourceId ?? "",
          settings.credentials,
        );
        await storeEvent(ctx, connection, event);
        return { code: "upserted", records: 1 };
      }
      const samples = Array.isArray(payload.samples) ? payload.samples : [];
      if (receipt.eventType === "SUUNTO_247_SLEEP_CREATED") {
        let stored = 0;
        for (const sample of samples) {
          const event = normalizeSuuntoSleep(sample);
          if (!event) continue;
          await storeEvent(ctx, connection, event);
          stored += 1;
        }
        return { code: "upserted", records: stored };
      }
      const points = samples.flatMap((sample) =>
        receipt.eventType === "SUUNTO_247_ACTIVITY_CREATED"
          ? normalizeSuuntoActivitySample(sample)
          : normalizeSuuntoRecoverySample(sample),
      );
      const records = await storePoints(ctx, connection, points);
      if (receipt.eventType === "SUUNTO_247_RECOVERY_CREATED") {
        await upsertRecoverySummaries(ctx, connection, points);
      }
      return { code: "upserted", records };
    } catch (error) {
      const classification = classifyProviderWebhookProcessingError(error);
      if (!classification.retryable) {
        return { code: classification.code, records: 0 };
      }
      throw error;
    }
  },
});

export const attachConnection = internalMutation({
  args: {
    receiptId: v.id("providerWebhookReceipts"),
    connectionId: v.id("connections"),
  },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt && receipt.status !== "canceled") {
      await ctx.db.patch(receipt._id, { connectionId: args.connectionId });
    }
  },
});

export const runProviderWebhook = providerWebhookWorkflow.define({
  args: { receiptId: v.id("providerWebhookReceipts") },
  returns: v.object({ code: v.string(), records: v.number() }),
  handler: async (step, args): Promise<{ code: string; records: number }> => {
    await step.runMutation(internal.providerWebhooks.markProcessing, args);
    return await step.runAction(internal.providerWebhooks.processReceipt, args);
  },
});

export const handleProviderWebhookComplete = internalMutation({
  args: {
    workflowId: v.string(),
    result: v.any(),
    context: v.object({ receiptId: v.id("providerWebhookReceipts") }),
  },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.context.receiptId);
    if (!receipt || receipt.status === "canceled" || receipt.status === "waiting_for_connection") {
      return;
    }
    if (args.result.kind === "success") {
      const result = args.result.returnValue as { code?: string } | undefined;
      const code = result?.code ?? "completed";
      const ignored =
        ["connection_inactive", "unsupported_event", "unsupported_route"].includes(code) ||
        code.startsWith("provider_4");
      await ctx.db.patch(receipt._id, {
        status: ignored ? "ignored" : "completed",
        resultCode: code,
        completedAt: Date.now(),
        workflowId: args.workflowId,
        payloadJson: "{}",
      });
      return;
    }
    if (args.result.kind === "canceled") {
      await ctx.db.patch(receipt._id, {
        status: "canceled",
        completedAt: Date.now(),
        workflowId: args.workflowId,
        payloadJson: "{}",
      });
      return;
    }
    await ctx.db.patch(receipt._id, {
      status: "failed",
      completedAt: Date.now(),
      workflowId: args.workflowId,
      errorCode: "processing_failed",
    });
  },
});

export const configureProviderWebhook = mutation({
  args: {
    provider: liveWebhookProvider,
    targetUrl: v.optional(v.string()),
    webhookSecret: v.optional(v.string()),
    eventTypes: v.optional(v.array(v.string())),
    status: v.optional(providerWebhookRegistrationStatus),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    if (args.provider === "whoop" && args.webhookSecret) {
      throw new Error("WHOOP uses the stored provider client secret");
    }
    if (args.targetUrl && new URL(args.targetUrl).protocol !== "https:") {
      throw new Error("Webhook targetUrl must use HTTPS");
    }
    const existing = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();
    const now = Date.now();
    const value = {
      provider: args.provider,
      targetUrl: args.targetUrl ?? existing?.targetUrl,
      webhookSecret: args.webhookSecret ?? existing?.webhookSecret,
      eventTypes: args.eventTypes ?? existing?.eventTypes,
      status: args.status ?? "active",
      modelVersion: args.provider === "whoop" ? ("v2" as const) : undefined,
      configuredAt: existing?.configuredAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, value);
      return existing._id;
    }
    return await ctx.db.insert("providerWebhookRegistrations", value);
  },
});

export const getProviderWebhookStatus = query({
  args: { provider: liveWebhookProvider },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, args) => {
    const registration = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();
    if (!registration) return null;
    const { webhookSecret: _secret, ...safe } = registration;
    const providerSettings =
      args.provider === "whoop"
        ? await ctx.db
            .query("providerSettings")
            .withIndex("by_provider", (idx) => idx.eq("provider", "whoop"))
            .first()
        : null;
    return {
      ...safe,
      secretConfigured: Boolean(
        args.provider === "whoop" ? providerSettings?.clientSecret : registration.webhookSecret,
      ),
    };
  },
});

/** Convenience status query for Polar registration management. */
export const getPolarWebhookStatus = query({
  args: {},
  returns: v.union(v.any(), v.null()),
  handler: async (ctx) => {
    const registration = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", "polar"))
      .first();
    if (!registration) return null;
    const { webhookSecret: _secret, ...safe } = registration;
    return { ...safe, secretConfigured: Boolean(registration.webhookSecret) };
  },
});

export const listProviderWebhookReceipts = query({
  args: {
    provider: v.optional(liveWebhookProvider),
    status: v.optional(providerWebhookReceiptStatus),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.object({ receipts: v.array(v.any()), nextCursor: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const status = args.status;
    const provider = args.provider;
    const before = args.before;
    const rows =
      provider && status
        ? await ctx.db
            .query("providerWebhookReceipts")
            .withIndex("by_provider_status_received", (idx) => {
              const scoped = idx.eq("provider", provider).eq("status", status);
              return before === undefined ? scoped : scoped.lt("receivedAt", before);
            })
            .order("desc")
            .take(limit)
        : provider
          ? await ctx.db
              .query("providerWebhookReceipts")
              .withIndex("by_provider_received", (idx) => {
                const scoped = idx.eq("provider", provider);
                return before === undefined ? scoped : scoped.lt("receivedAt", before);
              })
              .order("desc")
              .take(limit)
          : status
            ? await ctx.db
                .query("providerWebhookReceipts")
                .withIndex("by_status_received", (idx) => {
                  const scoped = idx.eq("status", status);
                  return before === undefined ? scoped : scoped.lt("receivedAt", before);
                })
                .order("desc")
                .take(limit)
            : await ctx.db
                .query("providerWebhookReceipts")
                .withIndex("by_received", (idx) =>
                  before === undefined ? idx : idx.lt("receivedAt", before),
                )
                .order("desc")
                .take(limit);
    return {
      receipts: rows.map(safeReceipt),
      nextCursor: rows.length === limit ? rows[rows.length - 1].receivedAt : null,
    };
  },
});

export const retryProviderWebhookReceipt = mutation({
  args: { receiptId: v.id("providerWebhookReceipts") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) throw new Error("Webhook receipt not found");
    if (receipt.expiresAt <= Date.now() || receipt.payloadJson === "{}") {
      throw new Error("Webhook receipt payload is no longer available");
    }
    if (!["failed", "waiting_for_connection"].includes(receipt.status)) {
      throw new Error(`Webhook receipt cannot be retried from ${receipt.status}`);
    }
    const workflowId = await providerWebhookWorkflow.start(
      ctx,
      internal.providerWebhooks.runProviderWebhook,
      { receiptId: receipt._id },
      {
        startAsync: true,
        onComplete: internal.providerWebhooks.handleProviderWebhookComplete,
        context: { receiptId: receipt._id },
      },
    );
    await ctx.db.patch(receipt._id, {
      status: "pending",
      workflowId,
      completedAt: undefined,
      errorCode: undefined,
    });
    return workflowId;
  },
});

export const cancelProviderWebhookReceipt = mutation({
  args: { receiptId: v.id("providerWebhookReceipts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt && !["completed", "ignored", "canceled"].includes(receipt.status)) {
      await ctx.db.patch(receipt._id, {
        status: "canceled",
        completedAt: Date.now(),
        payloadJson: "{}",
      });
    }
    return null;
  },
});

export const cleanupProviderWebhookReceipts = mutation({
  args: { now: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("providerWebhookReceipts")
      .withIndex("by_expiry", (idx) => idx.lte("expiresAt", args.now ?? Date.now()))
      .take(CLEANUP_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

export const cleanupExpiredProviderWebhookReceipt = internalMutation({
  args: { receiptId: v.id("providerWebhookReceipts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt && receipt.expiresAt <= Date.now()) await ctx.db.delete(receipt._id);
    return null;
  },
});

function polarAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function polarRequest(
  path: string,
  credentials: { clientId: string; clientSecret: string },
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${POLAR_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: polarAuthHeader(credentials.clientId, credentials.clientSecret),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Polar webhook API failed with HTTP ${response.status}`);
  return response.status === 204 ? null : await response.json();
}

export const beginPolarRegistration = internalMutation({
  args: { targetUrl: v.string(), eventTypes: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", "polar"))
      .first();
    if (existing?.status === "pending_verification")
      throw new Error("Polar registration in progress");
    const value = {
      provider: "polar" as const,
      status: "pending_verification" as const,
      targetUrl: args.targetUrl,
      eventTypes: args.eventTypes,
      lastErrorCode: undefined,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("providerWebhookRegistrations", value);
    return null;
  },
});

export const finishPolarRegistration = internalMutation({
  args: {
    remoteId: v.string(),
    targetUrl: v.string(),
    eventTypes: v.array(v.string()),
    webhookSecret: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", "polar"))
      .first();
    if (!existing) throw new Error("Polar registration state missing");
    const now = Date.now();
    await ctx.db.patch(existing._id, {
      ...args,
      status: "active",
      configuredAt: now,
      lastVerifiedAt: now,
      updatedAt: now,
      lastErrorCode: undefined,
    });
  },
});

export const createPolarWebhook = action({
  args: { targetUrl: v.string(), eventTypes: v.optional(v.array(v.string())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (new URL(args.targetUrl).protocol !== "https:") throw new Error("targetUrl must use HTTPS");
    const eventTypes = args.eventTypes ?? [...POLAR_SUPPORTED_EVENTS];
    if (eventTypes.some((event) => !POLAR_SUPPORTED_EVENTS.includes(event as "EXERCISE"))) {
      throw new Error("This release supports Polar EXERCISE webhooks only");
    }
    const settings = await ctx.runQuery(internal.providerWebhooks.getVerificationSettings, {
      provider: "polar",
    });
    if (!settings?.credentials) throw new Error("Polar credentials are not configured");
    await ctx.runMutation(internal.providerWebhooks.beginPolarRegistration, {
      targetUrl: args.targetUrl,
      eventTypes,
    });
    try {
      const response = (await polarRequest("/v3/webhooks", settings.credentials, {
        method: "POST",
        body: JSON.stringify({ url: args.targetUrl, events: eventTypes }),
      })) as Record<string, unknown>;
      const data = (isRecord(response.data) ? response.data : response) as Record<string, unknown>;
      const remoteId = stringField(data.id);
      const webhookSecret = stringField(data.signature_secret_key);
      if (!remoteId || !webhookSecret) {
        throw new Error("Polar did not return its one-time webhook secret");
      }
      await ctx.runMutation(internal.providerWebhooks.finishPolarRegistration, {
        remoteId,
        targetUrl: args.targetUrl,
        eventTypes,
        webhookSecret,
      });
      return {
        provider: "polar",
        status: "active",
        remoteId,
        targetUrl: args.targetUrl,
        eventTypes,
      };
    } catch (error) {
      await ctx.runMutation(internal.providerWebhooks.patchRegistrationStatus, {
        provider: "polar",
        status: "error",
        lastErrorCode: "registration_failed",
      });
      throw error;
    }
  },
});

export const updatePolarWebhook = action({
  args: { targetUrl: v.optional(v.string()), eventTypes: v.optional(v.array(v.string())) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const settings = await ctx.runQuery(internal.providerWebhooks.getVerificationSettings, {
      provider: "polar",
    });
    const registration = settings?.registration;
    if (!settings?.credentials || !registration?.remoteId)
      throw new Error("Polar webhook is not registered");
    const targetUrl = args.targetUrl ?? registration.targetUrl;
    const eventTypes = args.eventTypes ?? registration.eventTypes ?? [...POLAR_SUPPORTED_EVENTS];
    if (!targetUrl || new URL(targetUrl).protocol !== "https:")
      throw new Error("targetUrl must use HTTPS");
    if (eventTypes.some((event: string) => !POLAR_SUPPORTED_EVENTS.includes(event as "EXERCISE"))) {
      throw new Error("This release supports Polar EXERCISE webhooks only");
    }
    await polarRequest(
      `/v3/webhooks/${encodeURIComponent(registration.remoteId)}`,
      settings.credentials,
      {
        method: "PATCH",
        body: JSON.stringify({ url: targetUrl, events: eventTypes }),
      },
    );
    await ctx.runMutation(internal.providerWebhooks.patchRegistrationStatus, {
      provider: "polar",
      status: "active",
      targetUrl,
      eventTypes,
    });
    return {
      provider: "polar",
      status: "active",
      remoteId: registration.remoteId,
      targetUrl,
      eventTypes,
    };
  },
});

export const patchRegistrationStatus = internalMutation({
  args: {
    provider: liveWebhookProvider,
    status: providerWebhookRegistrationStatus,
    targetUrl: v.optional(v.string()),
    eventTypes: v.optional(v.array(v.string())),
    remoteId: v.optional(v.string()),
    clearSecret: v.optional(v.boolean()),
    clearRemote: v.optional(v.boolean()),
    clearTarget: v.optional(v.boolean()),
    reconciled: v.optional(v.boolean()),
    lastErrorCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerWebhookRegistrations")
      .withIndex("by_provider", (idx) => idx.eq("provider", args.provider))
      .first();
    if (!existing) return;
    await ctx.db.patch(existing._id, {
      status: args.status,
      targetUrl: args.clearTarget ? undefined : (args.targetUrl ?? existing.targetUrl),
      eventTypes: args.eventTypes ?? existing.eventTypes,
      remoteId: args.clearRemote ? undefined : (args.remoteId ?? existing.remoteId),
      webhookSecret: args.clearSecret ? undefined : existing.webhookSecret,
      lastReconciledAt: args.reconciled ? Date.now() : existing.lastReconciledAt,
      lastErrorCode: args.lastErrorCode,
      updatedAt: Date.now(),
    });
  },
});

async function polarLifecycleAction(
  ctx: Pick<ActionCtx, "runMutation" | "runQuery">,
  path: string,
  status: "active" | "paused" | "deactivated",
): Promise<{ status: string }> {
  const settings = await ctx.runQuery(internal.providerWebhooks.getVerificationSettings, {
    provider: "polar",
  });
  if (!settings?.credentials) throw new Error("Polar credentials are not configured");
  await polarRequest(path, settings.credentials, { method: "POST" });
  await ctx.runMutation(internal.providerWebhooks.patchRegistrationStatus, {
    provider: "polar",
    status,
  });
  return { status };
}

export const activatePolarWebhook = action({
  args: {},
  returns: v.any(),
  handler: async (ctx) => await polarLifecycleAction(ctx, "/v3/webhooks/activate", "active"),
});

export const deactivatePolarWebhook = action({
  args: {},
  returns: v.any(),
  handler: async (ctx) => await polarLifecycleAction(ctx, "/v3/webhooks/deactivate", "deactivated"),
});

export const deletePolarWebhook = action({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const settings = await ctx.runQuery(internal.providerWebhooks.getVerificationSettings, {
      provider: "polar",
    });
    const registration = settings?.registration;
    if (!settings?.credentials || !registration?.remoteId)
      throw new Error("Polar webhook is not registered");
    await polarRequest(
      `/v3/webhooks/${encodeURIComponent(registration.remoteId)}`,
      settings.credentials,
      {
        method: "DELETE",
      },
    );
    await ctx.runMutation(internal.providerWebhooks.patchRegistrationStatus, {
      provider: "polar",
      status: "unconfigured",
      clearSecret: true,
      clearRemote: true,
      clearTarget: true,
    });
    return { status: "unconfigured" };
  },
});

export const reconcilePolarWebhookRegistration = action({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const settings = await ctx.runQuery(internal.providerWebhooks.getVerificationSettings, {
      provider: "polar",
    });
    if (!settings?.credentials) throw new Error("Polar credentials are not configured");
    const response = (await polarRequest("/v3/webhooks", settings.credentials)) as Record<
      string,
      unknown
    >;
    const rows = Array.isArray(response.data) ? response.data : [];
    const remote = isRecord(rows[0]) ? rows[0] : undefined;
    const remoteId = stringField(remote?.id);
    const active = Boolean(remoteId && remote?.active !== false);
    const secretMissing = Boolean(remoteId && !settings.registration?.webhookSecret);
    await ctx.runMutation(internal.providerWebhooks.patchRegistrationStatus, {
      provider: "polar",
      status: secretMissing
        ? "error"
        : active
          ? "active"
          : remoteId
            ? "deactivated"
            : "unconfigured",
      remoteId,
      targetUrl: stringField(remote?.url),
      eventTypes: Array.isArray(remote?.events)
        ? remote.events.filter((event): event is string => typeof event === "string")
        : undefined,
      reconciled: true,
      clearSecret: !remoteId,
      clearRemote: !remoteId,
      clearTarget: !remoteId,
      lastErrorCode: secretMissing ? "signing_secret_missing_recreate_required" : undefined,
    });
    return {
      status: secretMissing
        ? "error"
        : active
          ? "active"
          : remoteId
            ? "deactivated"
            : "unconfigured",
      remoteId,
      requiresRecreation: secretMissing,
    };
  },
});

export function classifyProviderWebhookProcessingError(error: unknown): {
  retryable: boolean;
  code: string;
} {
  if (isProviderApiError(error)) {
    return { retryable: error.retryable || error.status === 401, code: `provider_${error.status}` };
  }
  return { retryable: true, code: "processing_failed" };
}
