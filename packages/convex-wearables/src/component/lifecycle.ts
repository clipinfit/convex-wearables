import { type Infer, v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  type DatabaseReader,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { captureOutgoingEvent } from "./outgoingWebhooks";
import { isProviderApiError } from "./providers/oauth";
import { getProvider } from "./providers/registry";
import type { ProviderCredentials } from "./providers/types";
import { type dataDeletionScope, providerDeregistrationStatus, providerName } from "./schema";
import { durableWorkflow, providerWebhookWorkflow } from "./workflowManager";

const DELETION_BATCH_SIZE = 200;
const BLOCKING_DELETION_STATUSES = ["pending", "running", "failed"] as const;

type ProviderName = Infer<typeof providerName>;
type DeletionScope = Infer<typeof dataDeletionScope>;
type DeregistrationStatus = Infer<typeof providerDeregistrationStatus>;

const deletedCountsValidator = v.object({
  connections: v.number(),
  dataSources: v.number(),
  dataPoints: v.number(),
  timeSeriesRollups: v.number(),
  timeSeriesSeriesState: v.number(),
  events: v.number(),
  workoutSegments: v.number(),
  workoutZones: v.number(),
  garminActivityFileJobs: v.number(),
  dailySummaries: v.number(),
  menstrualCycles: v.number(),
  syncJobs: v.number(),
  backfillJobs: v.number(),
  oauthStates: v.number(),
  pendingGarminPushPayloads: v.number(),
  providerWebhookReceipts: v.optional(v.number()),
  outgoingWebhookState: v.optional(v.number()),
  timeSeriesPolicyAssignments: v.number(),
  priorDataDeletionOperations: v.number(),
});

type DeletedCounts = Infer<typeof deletedCountsValidator>;
type DeletionPhase = keyof DeletedCounts;

const DELETION_PHASES: readonly DeletionPhase[] = [
  "pendingGarminPushPayloads",
  "providerWebhookReceipts",
  "outgoingWebhookState",
  "dataPoints",
  "timeSeriesRollups",
  "timeSeriesSeriesState",
  "workoutSegments",
  "workoutZones",
  "garminActivityFileJobs",
  "events",
  "dailySummaries",
  "menstrualCycles",
  "syncJobs",
  "backfillJobs",
  "oauthStates",
  "timeSeriesPolicyAssignments",
  "priorDataDeletionOperations",
  "dataSources",
  "connections",
];

function emptyDeletedCounts(): DeletedCounts {
  return {
    connections: 0,
    dataSources: 0,
    dataPoints: 0,
    timeSeriesRollups: 0,
    timeSeriesSeriesState: 0,
    events: 0,
    workoutSegments: 0,
    workoutZones: 0,
    garminActivityFileJobs: 0,
    dailySummaries: 0,
    menstrualCycles: 0,
    syncJobs: 0,
    backfillJobs: 0,
    oauthStates: 0,
    pendingGarminPushPayloads: 0,
    providerWebhookReceipts: 0,
    outgoingWebhookState: 0,
    timeSeriesPolicyAssignments: 0,
    priorDataDeletionOperations: 0,
  };
}

function operationBlocksProvider(
  operation: { scope: DeletionScope; provider?: ProviderName },
  provider?: ProviderName,
): boolean {
  return operation.scope === "user" || provider === undefined || operation.provider === provider;
}

async function findBlockingDeletion(
  ctx: { db: DatabaseReader },
  userId: string,
  provider?: ProviderName,
) {
  for (const status of BLOCKING_DELETION_STATUSES) {
    const operations = await ctx.db
      .query("dataDeletionOperations")
      .withIndex("by_user_status", (index) => index.eq("userId", userId).eq("status", status))
      .collect();
    const blocking = operations.find((operation) => operationBlocksProvider(operation, provider));
    if (blocking) return blocking;
  }
  return null;
}

/**
 * Mutation-level ingestion fence. Call this in the same transaction that
 * creates or reactivates user/provider data.
 */
export async function assertIngestionAllowed(
  ctx: { db: DatabaseReader },
  args: { userId: string; provider?: ProviderName },
): Promise<void> {
  const blocking = await findBlockingDeletion(ctx, args.userId, args.provider);
  if (blocking) {
    throw new Error(`Wearable ingestion is blocked by data deletion operation ${blocking._id}`);
  }
}

function sameDeletionRequest(
  operation: { scope: DeletionScope; provider?: ProviderName },
  scope: DeletionScope,
  provider?: ProviderName,
) {
  return operation.scope === scope && operation.provider === provider;
}

function requireDeletionProvider(operation: { provider?: ProviderName }): ProviderName {
  if (!operation.provider) throw new Error("Provider deletion operation is missing provider");
  return operation.provider;
}

async function startDeletion(
  ctx: MutationCtx,
  args: {
    userId: string;
    scope: DeletionScope;
    provider?: ProviderName;
    idempotencyKey: string;
    deregisterProviders: boolean;
  },
) {
  const idempotencyKey = args.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("idempotencyKey must not be empty");

  const existing = await ctx.db
    .query("dataDeletionOperations")
    .withIndex("by_user_idempotency_key", (index) =>
      index.eq("userId", args.userId).eq("idempotencyKey", idempotencyKey),
    )
    .order("desc")
    .first();

  if (existing) {
    if (!sameDeletionRequest(existing, args.scope, args.provider)) {
      throw new Error("The idempotency key is already used by a different deletion scope");
    }
    return {
      operationId: existing._id,
      workflowId: existing.workflowId ?? "",
      deduped: true,
    };
  }

  const blocking = await findBlockingDeletion(ctx, args.userId, args.provider);
  if (blocking) {
    throw new Error(`A conflicting data deletion operation is already active: ${blocking._id}`);
  }

  if (args.scope === "user") {
    for (const status of BLOCKING_DELETION_STATUSES) {
      const anyScoped = await ctx.db
        .query("dataDeletionOperations")
        .withIndex("by_user_status", (index) =>
          index.eq("userId", args.userId).eq("status", status),
        )
        .first();
      if (anyScoped) {
        throw new Error(`A provider deletion operation is already active: ${anyScoped._id}`);
      }
    }
  }

  const now = Date.now();
  const operationId = await ctx.db.insert("dataDeletionOperations", {
    userId: args.userId,
    scope: args.scope,
    provider: args.provider,
    idempotencyKey,
    status: "pending",
    requestedDeregistration: args.deregisterProviders,
    deregistrationStatus: args.deregisterProviders ? "pending" : "not_requested",
    deletedCounts: emptyDeletedCounts(),
    createdAt: now,
    updatedAt: now,
  });

  await captureOutgoingEvent(ctx, {
    userId: args.userId,
    provider: args.provider,
    eventType: "data_deletion.started",
    subjectKind: "deletion",
    subjectId: String(operationId),
    idempotencyKey: `deletion:${idempotencyKey}:started`,
    data: { operationId: String(operationId), scope: args.scope, provider: args.provider },
  });

  const workflowId = await durableWorkflow.start(
    ctx,
    internal.lifecycle.runDataDeletion,
    { operationId },
    {
      startAsync: true,
      onComplete: internal.lifecycle.handleDataDeletionComplete,
      context: { operationId },
    },
  );
  await ctx.db.patch(operationId, { workflowId, updatedAt: Date.now() });

  return { operationId, workflowId, deduped: false };
}

export const startProviderDataDeletion = mutation({
  args: {
    userId: v.string(),
    provider: providerName,
    idempotencyKey: v.string(),
    deregister: v.optional(v.boolean()),
  },
  returns: v.object({
    operationId: v.id("dataDeletionOperations"),
    workflowId: v.string(),
    deduped: v.boolean(),
  }),
  handler: async (ctx, args) =>
    await startDeletion(ctx, {
      userId: args.userId,
      scope: "provider",
      provider: args.provider,
      idempotencyKey: args.idempotencyKey,
      deregisterProviders: args.deregister ?? false,
    }),
});

export const startUserDataDeletion = mutation({
  args: {
    userId: v.string(),
    idempotencyKey: v.string(),
    deregisterProviders: v.optional(v.boolean()),
  },
  returns: v.object({
    operationId: v.id("dataDeletionOperations"),
    workflowId: v.string(),
    deduped: v.boolean(),
  }),
  handler: async (ctx, args) =>
    await startDeletion(ctx, {
      userId: args.userId,
      scope: "user",
      idempotencyKey: args.idempotencyKey,
      deregisterProviders: args.deregisterProviders ?? false,
    }),
});

export const getDataDeletionOperation = query({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.get(args.operationId),
});

export const getActiveDataDeletionOperation = query({
  args: { userId: v.string(), provider: v.optional(providerName) },
  returns: v.any(),
  handler: async (ctx, args) => await findBlockingDeletion(ctx, args.userId, args.provider),
});

export const updateDeregistrationStatus = internalMutation({
  args: {
    operationId: v.id("dataDeletionOperations"),
    deregistrationStatus: providerDeregistrationStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation) throw new Error(`Deletion operation ${args.operationId} not found`);
    await ctx.db.patch(operation._id, {
      deregistrationStatus: args.deregistrationStatus,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const getOperationInternal = internalQuery({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.get(args.operationId),
});

export const getConnectionsForDeletion = internalQuery({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation) throw new Error(`Deletion operation ${args.operationId} not found`);
    if (operation.scope === "provider") {
      return await ctx.db
        .query("connections")
        .withIndex("by_user_provider", (index) =>
          index.eq("userId", operation.userId).eq("provider", requireDeletionProvider(operation)),
        )
        .collect();
    }
    return await ctx.db
      .query("connections")
      .withIndex("by_user", (index) => index.eq("userId", operation.userId))
      .collect();
  },
});

const deregistrationResultValidator = v.object({
  status: v.union(v.literal("completed"), v.literal("unsupported"), v.literal("failed")),
  errorCode: v.optional(v.string()),
});

export const deregisterConnection = internalAction({
  args: { connectionId: v.id("connections") },
  returns: deregistrationResultValidator,
  handler: async (ctx, args) => {
    const connection = await ctx.runQuery(internal.connections.getById, args);
    if (!connection?.accessToken) return { status: "completed" as const };

    const adapter = getProvider(connection.provider);
    if (!adapter?.deregisterUser) return { status: "unsupported" as const };

    const storedCredentials = await ctx.runQuery(internal.providerSettings.getCredentials, {
      provider: connection.provider,
    });
    const credentials: ProviderCredentials | undefined = storedCredentials
      ? {
          clientId: storedCredentials.clientId,
          clientSecret: storedCredentials.clientSecret,
          subscriptionKey: storedCredentials.subscriptionKey,
        }
      : undefined;

    try {
      await adapter.deregisterUser(connection.accessToken, connection.providerUserId, credentials);
      return { status: "completed" as const };
    } catch (error) {
      if (isProviderApiError(error) && error.retryable) throw error;
      return {
        status: "failed" as const,
        errorCode: isProviderApiError(error)
          ? `provider_http_${error.status}`
          : "provider_deregistration_failed",
      };
    }
  },
});

export function summarizeDeregistrationResults(
  results: Array<Infer<typeof deregistrationResultValidator>>,
): DeregistrationStatus {
  if (results.length === 0 || results.every((result) => result.status === "completed")) {
    return "completed";
  }
  const completed = results.some((result) => result.status === "completed");
  const failed = results.some((result) => result.status === "failed");
  if (completed) return "partially_completed";
  if (failed) return "failed";
  return "unsupported";
}

export const prepareDeletionScope = internalMutation({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation) throw new Error(`Deletion operation ${args.operationId} not found`);

    const connections =
      operation.scope === "provider"
        ? await ctx.db
            .query("connections")
            .withIndex("by_user_provider", (index) =>
              index
                .eq("userId", operation.userId)
                .eq("provider", requireDeletionProvider(operation)),
            )
            .collect()
        : await ctx.db
            .query("connections")
            .withIndex("by_user", (index) => index.eq("userId", operation.userId))
            .collect();

    const syncJobs = await ctx.db
      .query("syncJobs")
      .withIndex("by_user", (index) => index.eq("userId", operation.userId))
      .collect();
    for (const job of syncJobs) {
      if (operation.scope === "provider" && job.provider !== operation.provider) {
        continue;
      }
      if ((job.status === "queued" || job.status === "running") && job.workflowId) {
        try {
          await durableWorkflow.cancel(ctx, job.workflowId as never);
        } catch {
          // Completion may race cancellation; the ingestion fence still prevents writes.
        }
        await ctx.db.patch(job._id, { status: "canceled", completedAt: Date.now() });
      }
    }

    for (const connection of connections) {
      const receipts = await ctx.db
        .query("providerWebhookReceipts")
        .withIndex("by_connection_status", (index) => index.eq("connectionId", connection._id))
        .collect();
      for (const receipt of receipts) {
        if (
          (receipt.status === "pending" ||
            receipt.status === "processing" ||
            receipt.status === "waiting_for_connection") &&
          receipt.workflowId
        ) {
          try {
            await providerWebhookWorkflow.cancel(ctx, receipt.workflowId as never);
          } catch {
            // Completion may race cancellation; the ingestion fence still prevents writes.
          }
        }
        if (!["completed", "ignored", "canceled"].includes(receipt.status)) {
          await ctx.db.patch(receipt._id, {
            status: "canceled",
            completedAt: Date.now(),
            resultCode: "canceled_by_deletion",
            payloadJson: "{}",
          });
        }
      }

      const backfills = await ctx.db
        .query("backfillJobs")
        .withIndex("by_connection", (index) => index.eq("connectionId", connection._id))
        .collect();
      for (const job of backfills) {
        if ((job.status === "queued" || job.status === "running") && job.workflowId) {
          try {
            await durableWorkflow.cancel(ctx, job.workflowId as never);
          } catch {
            // Completion may race cancellation; the ingestion fence still prevents writes.
          }
          await ctx.db.patch(job._id, { status: "canceled", completedAt: Date.now() });
        }
      }

      await ctx.db.patch(connection._id, {
        status: "inactive",
        accessToken: undefined,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
      });
    }

    const tenantMapping = await ctx.db
      .query("outgoingWebhookUserTenants")
      .withIndex("by_user", (index) => index.eq("userId", operation.userId))
      .first();
    if (tenantMapping) {
      const queuedEvents = await ctx.db
        .query("outgoingWebhookEvents")
        .withIndex("by_tenant_user_time", (index) =>
          index.eq("tenantId", tenantMapping.tenantId).eq("userId", operation.userId),
        )
        .collect();
      for (const event of queuedEvents) {
        if (operation.scope === "provider" && event.provider !== operation.provider) continue;
        await ctx.db.patch(event._id, {
          payloadJson: "{}",
          referencePayloadJson: "{}",
          fanoutStatus: "completed",
        });
        const deliveries = await ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_event_endpoint", (index) => index.eq("eventId", event._id))
          .collect();
        for (const delivery of deliveries) {
          if (["pending", "delivering", "retry_scheduled"].includes(delivery.status)) {
            await ctx.db.patch(delivery._id, {
              status: "canceled",
              payloadJson: "{}",
              nextAttemptAt: undefined,
              lockedAt: undefined,
              leaseToken: undefined,
              updatedAt: Date.now(),
            });
          }
        }
      }
    }

    await ctx.db.patch(operation._id, {
      status: "running",
      currentPhase: "preparing",
      updatedAt: Date.now(),
    });
    return null;
  },
});

async function scopedConnections(
  ctx: MutationCtx,
  operation: { userId: string; scope: DeletionScope; provider?: ProviderName },
) {
  if (operation.scope === "provider") {
    return await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (index) =>
        index.eq("userId", operation.userId).eq("provider", requireDeletionProvider(operation)),
      )
      .collect();
  }
  return await ctx.db
    .query("connections")
    .withIndex("by_user", (index) => index.eq("userId", operation.userId))
    .collect();
}

async function scopedDataSources(
  ctx: MutationCtx,
  operation: { userId: string; scope: DeletionScope; provider?: ProviderName },
) {
  return operation.scope === "provider"
    ? await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (index) =>
          index.eq("userId", operation.userId).eq("provider", requireDeletionProvider(operation)),
        )
        .collect()
    : await ctx.db
        .query("dataSources")
        .withIndex("by_user_provider", (index) => index.eq("userId", operation.userId))
        .collect();
}

async function deleteSourceChildren(
  ctx: MutationCtx,
  sourceIds: Id<"dataSources">[],
  phase: "dataPoints" | "timeSeriesRollups" | "timeSeriesSeriesState" | "events",
) {
  let deleted = 0;
  for (const sourceId of sourceIds) {
    const remaining = DELETION_BATCH_SIZE - deleted;
    if (remaining <= 0) break;
    if (phase === "dataPoints") {
      const rows = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (index) => index.eq("dataSourceId", sourceId))
        .take(remaining);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
    } else if (phase === "timeSeriesRollups") {
      const rows = await ctx.db
        .query("timeSeriesRollups")
        .withIndex("by_source_type_bucket", (index) => index.eq("dataSourceId", sourceId))
        .take(remaining);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
    } else if (phase === "timeSeriesSeriesState") {
      const rows = await ctx.db
        .query("timeSeriesSeriesState")
        .withIndex("by_source_series", (index) => index.eq("dataSourceId", sourceId))
        .take(remaining);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
    } else {
      const rows = await ctx.db
        .query("events")
        .withIndex("by_source_category_time", (index) => index.eq("dataSourceId", sourceId))
        .take(remaining);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
    }
  }
  return deleted;
}

async function deleteScopedBatchHandler(
  ctx: MutationCtx,
  args: { operationId: Id<"dataDeletionOperations">; phase: DeletionPhase },
) {
  const operation = await ctx.db.get(args.operationId);
  if (!operation) throw new Error(`Deletion operation ${args.operationId} not found`);
  if (operation.status === "canceled") throw new Error("Deletion operation was canceled");

  let deleted = 0;
  const connections = await scopedConnections(ctx, operation);
  const connectionIds = connections.map((connection) => connection._id);
  const sources = await scopedDataSources(ctx, operation);
  const sourceIds = sources.map((source) => source._id);

  if (
    args.phase === "dataPoints" ||
    args.phase === "timeSeriesRollups" ||
    args.phase === "timeSeriesSeriesState" ||
    args.phase === "events"
  ) {
    deleted = await deleteSourceChildren(ctx, sourceIds, args.phase);
  } else if (args.phase === "workoutSegments" || args.phase === "workoutZones") {
    const rows =
      operation.scope === "provider"
        ? await ctx.db
            .query(args.phase)
            .withIndex("by_user_provider", (index) =>
              index
                .eq("userId", operation.userId)
                .eq("provider", requireDeletionProvider(operation)),
            )
            .take(DELETION_BATCH_SIZE)
        : await ctx.db
            .query(args.phase)
            .withIndex("by_user_provider", (index) => index.eq("userId", operation.userId))
            .take(DELETION_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    deleted = rows.length;
  } else if (args.phase === "garminActivityFileJobs") {
    if (operation.scope !== "provider" || operation.provider === "garmin") {
      for (const connectionId of connectionIds) {
        const rows = await ctx.db
          .query("garminActivityFileJobs")
          .withIndex("by_connection_status", (index) => index.eq("connectionId", connectionId))
          .take(DELETION_BATCH_SIZE - deleted);
        for (const row of rows) await ctx.db.delete(row._id);
        deleted += rows.length;
        if (deleted >= DELETION_BATCH_SIZE) break;
      }
    }
  } else if (args.phase === "pendingGarminPushPayloads") {
    for (const connectionId of connectionIds) {
      const rows = await ctx.db
        .query("pendingGarminPushPayloads")
        .withIndex("by_connection_status", (index) => index.eq("connectionId", connectionId))
        .take(DELETION_BATCH_SIZE - deleted);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
      if (deleted >= DELETION_BATCH_SIZE) break;
    }
  } else if (args.phase === "providerWebhookReceipts") {
    for (const connectionId of connectionIds) {
      const rows = await ctx.db
        .query("providerWebhookReceipts")
        .withIndex("by_connection_status", (index) => index.eq("connectionId", connectionId))
        .take(DELETION_BATCH_SIZE - deleted);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
      if (deleted >= DELETION_BATCH_SIZE) break;
    }
  } else if (args.phase === "outgoingWebhookState") {
    const mapping = await ctx.db
      .query("outgoingWebhookUserTenants")
      .withIndex("by_user", (index) => index.eq("userId", operation.userId))
      .first();
    if (mapping) {
      const events =
        operation.scope === "provider"
          ? await ctx.db
              .query("outgoingWebhookEvents")
              .withIndex("by_tenant_user_provider_time", (index) =>
                index
                  .eq("tenantId", mapping.tenantId)
                  .eq("userId", operation.userId)
                  .eq("provider", requireDeletionProvider(operation)),
              )
              .take(DELETION_BATCH_SIZE)
          : await ctx.db
              .query("outgoingWebhookEvents")
              .withIndex("by_tenant_user_time", (index) =>
                index.eq("tenantId", mapping.tenantId).eq("userId", operation.userId),
              )
              .take(DELETION_BATCH_SIZE);
      for (const event of events) {
        const deliveries = await ctx.db
          .query("outgoingWebhookDeliveries")
          .withIndex("by_event_endpoint", (index) => index.eq("eventId", event._id))
          .collect();
        for (const delivery of deliveries) {
          const attempts = await ctx.db
            .query("outgoingWebhookAttempts")
            .withIndex("by_delivery_time", (index) => index.eq("deliveryId", delivery._id))
            .collect();
          for (const attempt of attempts) await ctx.db.delete(attempt._id);
          await ctx.db.delete(delivery._id);
        }
        await ctx.db.delete(event._id);
        deleted++;
      }
      if (operation.scope === "user" && events.length < DELETION_BATCH_SIZE) {
        const endpoints = await ctx.db
          .query("outgoingWebhookEndpoints")
          .withIndex("by_tenant_user_status", (index) =>
            index.eq("tenantId", mapping.tenantId).eq("userId", operation.userId),
          )
          .collect();
        for (const endpoint of endpoints) {
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
          deleted++;
        }
      }
    }
  } else if (args.phase === "dailySummaries") {
    let rows =
      operation.scope === "provider"
        ? await ctx.db
            .query("dailySummaries")
            .withIndex("by_user_provider_date", (index) =>
              index
                .eq("userId", operation.userId)
                .eq("provider", requireDeletionProvider(operation)),
            )
            .take(DELETION_BATCH_SIZE)
        : await ctx.db
            .query("dailySummaries")
            .withIndex("by_user_date", (index) => index.eq("userId", operation.userId))
            .take(DELETION_BATCH_SIZE);
    if (operation.scope === "provider" && rows.length < DELETION_BATCH_SIZE) {
      const ids = new Set(rows.map((row) => row._id));
      for (const sourceId of sourceIds) {
        const sourceRows = await ctx.db
          .query("dailySummaries")
          .withIndex("by_data_source", (index) => index.eq("dataSourceId", sourceId))
          .take(DELETION_BATCH_SIZE - rows.length);
        rows = [...rows, ...sourceRows.filter((row) => !ids.has(row._id))];
        for (const row of sourceRows) ids.add(row._id);
        if (rows.length >= DELETION_BATCH_SIZE) break;
      }
    }
    for (const row of rows) await ctx.db.delete(row._id);
    deleted = rows.length;
  } else if (args.phase === "menstrualCycles") {
    const rows = await ctx.db
      .query("menstrualCycles")
      .withIndex("by_user_provider", (index) => {
        const scoped = index.eq("userId", operation.userId);
        return operation.scope === "provider"
          ? scoped.eq("provider", requireDeletionProvider(operation))
          : scoped;
      })
      .take(DELETION_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    deleted = rows.length;
  } else if (args.phase === "syncJobs") {
    const rows = await ctx.db
      .query("syncJobs")
      .withIndex("by_user_provider", (index) => {
        const scoped = index.eq("userId", operation.userId);
        return operation.scope === "provider"
          ? scoped.eq("provider", requireDeletionProvider(operation))
          : scoped;
      })
      .take(DELETION_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    deleted = rows.length;
  } else if (args.phase === "backfillJobs") {
    for (const connectionId of connectionIds) {
      const rows = await ctx.db
        .query("backfillJobs")
        .withIndex("by_connection", (index) => index.eq("connectionId", connectionId))
        .take(DELETION_BATCH_SIZE - deleted);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
      if (deleted >= DELETION_BATCH_SIZE) break;
    }
  } else if (args.phase === "oauthStates") {
    const rows = await ctx.db
      .query("oauthStates")
      .withIndex("by_user_provider", (index) => {
        const scoped = index.eq("userId", operation.userId);
        return operation.scope === "provider"
          ? scoped.eq("provider", requireDeletionProvider(operation))
          : scoped;
      })
      .take(DELETION_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    deleted = rows.length;
  } else if (args.phase === "timeSeriesPolicyAssignments") {
    if (operation.scope === "user") {
      const rows = await ctx.db
        .query("timeSeriesPolicyAssignments")
        .withIndex("by_user", (index) => index.eq("userId", operation.userId))
        .take(DELETION_BATCH_SIZE);
      for (const row of rows) await ctx.db.delete(row._id);
      deleted = rows.length;
    }
  } else if (args.phase === "priorDataDeletionOperations") {
    if (operation.scope === "user") {
      const rows = await ctx.db
        .query("dataDeletionOperations")
        .withIndex("by_user_created_at", (index) => index.eq("userId", operation.userId))
        .take(DELETION_BATCH_SIZE + 1);
      const priorRows = rows
        .filter((row) => row._id !== operation._id)
        .slice(0, DELETION_BATCH_SIZE);
      for (const row of priorRows) await ctx.db.delete(row._id);
      deleted = priorRows.length;
    }
  } else if (args.phase === "dataSources") {
    const rows = sources.slice(0, DELETION_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    deleted = rows.length;
  } else if (args.phase === "connections") {
    const rows = connections.slice(0, DELETION_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    deleted = rows.length;
  }

  const deletedCounts = {
    ...operation.deletedCounts,
    [args.phase]: (operation.deletedCounts[args.phase] ?? 0) + deleted,
  };
  await ctx.db.patch(operation._id, {
    status: "running",
    currentPhase: args.phase,
    deletedCounts,
    updatedAt: Date.now(),
  });
  return { deleted };
}

export const deleteScopedBatch = internalMutation({
  args: {
    operationId: v.id("dataDeletionOperations"),
    phase: v.union(...DELETION_PHASES.map((phase) => v.literal(phase))),
  },
  returns: v.object({ deleted: v.number() }),
  handler: deleteScopedBatchHandler,
});

export const runDataDeletion = durableWorkflow.define({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.object({
    deletedCounts: deletedCountsValidator,
    deregistrationStatus: providerDeregistrationStatus,
  }),
  handler: async (step, args) => {
    const operation = await step.runQuery(internal.lifecycle.getOperationInternal, args);
    if (!operation) throw new Error(`Deletion operation ${args.operationId} not found`);

    let deregistrationStatus: DeregistrationStatus = "not_requested";
    if (operation.requestedDeregistration) {
      const connections = await step.runQuery(internal.lifecycle.getConnectionsForDeletion, args);
      const results: Array<Infer<typeof deregistrationResultValidator>> = [];
      for (const connection of connections) {
        try {
          results.push(
            await step.runAction(internal.lifecycle.deregisterConnection, {
              connectionId: connection._id,
            }),
          );
        } catch {
          results.push({ status: "failed", errorCode: "provider_deregistration_retry_exhausted" });
        }
      }
      deregistrationStatus = summarizeDeregistrationResults(results);
      await step.runMutation(internal.lifecycle.updateDeregistrationStatus, {
        operationId: args.operationId,
        deregistrationStatus,
      });
    }

    await step.runMutation(internal.lifecycle.prepareDeletionScope, args);
    for (const phase of DELETION_PHASES) {
      while (true) {
        const result = await step.runMutation(internal.lifecycle.deleteScopedBatch, {
          operationId: args.operationId,
          phase,
        });
        if (result.deleted === 0) break;
      }
    }

    const completed = await step.runQuery(internal.lifecycle.getOperationInternal, args);
    if (!completed) throw new Error(`Deletion operation ${args.operationId} not found`);
    return { deletedCounts: completed.deletedCounts, deregistrationStatus };
  },
});

export const handleDataDeletionComplete = internalMutation({
  args: {
    workflowId: v.string(),
    result: v.any(),
    context: v.object({ operationId: v.id("dataDeletionOperations") }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.context.operationId);
    if (!operation) return null;
    const now = Date.now();

    if (args.result.kind === "success") {
      const value = args.result.returnValue as {
        deletedCounts: DeletedCounts;
        deregistrationStatus: DeregistrationStatus;
      };
      const hasWarnings = !["not_requested", "completed"].includes(value.deregistrationStatus);
      await ctx.db.patch(operation._id, {
        workflowId: args.workflowId,
        status: hasWarnings ? "completed_with_warnings" : "completed",
        currentPhase: "completed",
        deregistrationStatus: value.deregistrationStatus,
        deletedCounts: value.deletedCounts,
        updatedAt: now,
        completedAt: now,
      });
      await captureOutgoingEvent(ctx, {
        userId: operation.userId,
        provider: operation.provider,
        eventType: hasWarnings
          ? "data_deletion.completed_with_warnings"
          : "data_deletion.completed",
        subjectKind: "deletion",
        subjectId: String(operation._id),
        idempotencyKey: `deletion:${operation.idempotencyKey}:${hasWarnings ? "completed_with_warnings" : "completed"}`,
        data: {
          operationId: String(operation._id),
          scope: operation.scope,
          provider: operation.provider,
          status: hasWarnings ? "completed_with_warnings" : "completed",
        },
      });
      if (operation.scope === "user") {
        const mapping = await ctx.db
          .query("outgoingWebhookUserTenants")
          .withIndex("by_user", (index) => index.eq("userId", operation.userId))
          .first();
        if (mapping) await ctx.db.delete(mapping._id);
      }
      return null;
    }

    if (args.result.kind === "canceled") {
      await ctx.db.patch(operation._id, {
        workflowId: args.workflowId,
        status: "canceled",
        currentPhase: "canceled",
        updatedAt: now,
        completedAt: now,
      });
      return null;
    }

    await ctx.db.patch(operation._id, {
      workflowId: args.workflowId,
      status: "failed",
      currentPhase: "failed",
      errorCode: "deletion_workflow_failed",
      errorMessage: "Data deletion did not finish. Retry or cancel the operation.",
      updatedAt: now,
      completedAt: now,
    });
    return null;
  },
});

export const retryDataDeletion = mutation({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation) throw new Error(`Deletion operation ${args.operationId} not found`);
    if (operation.status !== "failed" || !operation.workflowId) {
      throw new Error("Only a failed deletion operation can be retried");
    }
    await durableWorkflow.restart(ctx, operation.workflowId as never, { startAsync: true });
    await ctx.db.patch(operation._id, {
      status: "pending",
      currentPhase: "retrying",
      errorCode: undefined,
      errorMessage: undefined,
      completedAt: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const cancelDataDeletion = mutation({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation) throw new Error(`Deletion operation ${args.operationId} not found`);
    if (["completed", "completed_with_warnings", "canceled"].includes(operation.status)) {
      return null;
    }
    if (operation.workflowId && operation.status !== "failed") {
      await durableWorkflow.cancel(ctx, operation.workflowId as never);
    }
    await ctx.db.patch(operation._id, {
      status: "canceled",
      currentPhase: "canceled",
      updatedAt: Date.now(),
      completedAt: Date.now(),
    });
    return null;
  },
});

export const cleanupDataDeletionOperation = mutation({
  args: { operationId: v.id("dataDeletionOperations") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const operation = await ctx.db.get(args.operationId);
    if (!operation) return null;
    if (!["completed", "completed_with_warnings", "canceled"].includes(operation.status)) {
      throw new Error("Only a terminal deletion operation can be cleaned up");
    }
    if (operation.workflowId) {
      const cleaned = await durableWorkflow.cleanup(ctx, operation.workflowId as never);
      if (!cleaned) throw new Error("Workflow history is not ready for cleanup");
    }
    await ctx.db.delete(operation._id);
    return null;
  },
});

export const getConnectionForDeregistration = internalQuery({
  args: { userId: v.string(), provider: providerName },
  returns: v.any(),
  handler: async (ctx, args) =>
    await ctx.db
      .query("connections")
      .withIndex("by_user_provider", (index) =>
        index.eq("userId", args.userId).eq("provider", args.provider),
      )
      .first(),
});

export const deregisterProvider = action({
  args: { userId: v.string(), provider: providerName },
  returns: v.object({
    connectionFound: v.boolean(),
    status: v.union(v.literal("completed"), v.literal("unsupported"), v.literal("failed")),
    errorCode: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const connection = await ctx.runQuery(internal.lifecycle.getConnectionForDeregistration, args);
    if (!connection) return { connectionFound: false, status: "completed" as const };

    let result: Infer<typeof deregistrationResultValidator>;
    try {
      result = await ctx.runAction(internal.lifecycle.deregisterConnection, {
        connectionId: connection._id,
      });
    } catch {
      result = { status: "failed", errorCode: "provider_deregistration_retry_exhausted" };
    }
    await ctx.runMutation(api.connections.disconnect, args);
    return { connectionFound: true, ...result };
  },
});

/**
 * @deprecated Use startUserDataDeletion. This legacy mutation can exceed
 * Convex execution limits for large users and remains only for compatibility.
 */
export const deleteAllUserData = mutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_user", (index) => index.eq("userId", args.userId))
      .collect();
    for (const connection of connections) {
      const backfills = await ctx.db
        .query("backfillJobs")
        .withIndex("by_connection", (index) => index.eq("connectionId", connection._id))
        .collect();
      for (const backfill of backfills) await ctx.db.delete(backfill._id);
    }

    const operationId = await ctx.db.insert("dataDeletionOperations", {
      userId: args.userId,
      scope: "user",
      idempotencyKey: `legacy:${Date.now()}`,
      status: "running",
      requestedDeregistration: false,
      deregistrationStatus: "not_requested",
      deletedCounts: emptyDeletedCounts(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    for (const phase of DELETION_PHASES) {
      while (true) {
        const result = await deleteScopedBatchHandler(ctx, { operationId, phase });
        if (result.deleted === 0) break;
      }
    }
    await ctx.db.delete(operationId);
    return null;
  },
});
