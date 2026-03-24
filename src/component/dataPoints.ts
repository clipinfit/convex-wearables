import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type DatabaseReader,
  type DatabaseWriter,
  internalMutation,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { providerName, timeSeriesAggregation } from "./schema";
import {
  buildBuiltinFullTiers,
  comparePolicyScopes,
  createTimeSeriesPolicyScopeKey,
  DEFAULT_MAINTENANCE_INTERVAL_MS,
  DEFAULT_POLICY_SET_KEY,
  DEFAULT_TIME_SERIES_AGGREGATIONS,
  findTierForAge,
  getBucketEnd,
  getBucketStart,
  getRawTier,
  inferTimeSeriesPolicyScope,
  type NormalizedTimeSeriesTier,
  normalizeAggregations,
  normalizeTimeSeriesPolicyRuleInputs,
  parseDurationInput,
  resolveScopedPolicyRule,
  type TimeSeriesAggregation,
  type TimeSeriesPolicyRuleInput,
} from "./timeSeriesPolicyUtils";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_QUERY_LIMIT = 2000;
const MAINTENANCE_SETTINGS_KEY = "default";
const MAINTENANCE_BATCH_SIZE = 20;
const MAINTENANCE_POINT_BATCH_SIZE = 2000;
const MAINTENANCE_ROLLUP_BATCH_SIZE = 500;
const LONG_IDLE_MAINTENANCE_MS = 30 * DAY_MS;

type StoredPolicyRule = Doc<"timeSeriesPolicyRules">;
type StoredRollup = Doc<"timeSeriesRollups">;
type StoredSeriesState = Doc<"timeSeriesSeriesState">;

type DurationInput = string | number;

type TimeSeriesPoint = {
  timestamp: number;
  value: number;
  resolution?: "raw" | "rollup";
  bucketMinutes?: number;
  avg?: number;
  min?: number;
  max?: number;
  last?: number;
  count?: number;
};

type StoredPointInput = {
  recordedAt: number;
  value: number;
  externalId?: string;
};

type AggregatedStats = {
  avg: number;
  min: number;
  max: number;
  last: number;
  lastRecordedAt: number;
  count: number;
};

type EffectivePolicy = {
  tiers: NormalizedTimeSeriesTier[];
  sourceKind: "preset" | "default" | "builtin";
  sourceKey: string | null;
  matchedScope: "default" | "global" | "provider" | "series" | "provider_series";
  provider?: string;
  seriesType?: string;
};

type PolicySettingsDoc =
  | Doc<"timeSeriesPolicySettings">
  | {
      key: string;
      maintenanceEnabled: boolean;
      maintenanceIntervalMs: number;
      updatedAt: number;
    };

type TimeSeriesReadDb = Pick<DatabaseReader, "get" | "query">;
type TimeSeriesWriteDb = Pick<DatabaseWriter, "delete" | "get" | "insert" | "patch" | "query">;
type TimeSeriesMutationContext = Pick<MutationCtx, "db" | "scheduler">;

const durationInputValidator = v.union(v.string(), v.number());

const tierInputValidator = v.union(
  v.object({
    kind: v.literal("raw"),
    fromAge: durationInputValidator,
    toAge: v.union(durationInputValidator, v.null()),
  }),
  v.object({
    kind: v.literal("rollup"),
    fromAge: durationInputValidator,
    toAge: v.union(durationInputValidator, v.null()),
    bucket: durationInputValidator,
    aggregations: v.optional(v.array(timeSeriesAggregation)),
  }),
);

const policyRuleInputValidator = v.object({
  provider: v.optional(providerName),
  seriesType: v.optional(v.string()),
  tiers: v.array(tierInputValidator),
});

const policyPresetInputValidator = v.object({
  key: v.string(),
  rules: v.array(policyRuleInputValidator),
});

const maintenanceInputValidator = v.object({
  enabled: v.optional(v.boolean()),
  interval: v.optional(durationInputValidator),
});

const timeSeriesPointValidator = v.object({
  timestamp: v.number(),
  value: v.number(),
  resolution: v.optional(v.union(v.literal("raw"), v.literal("rollup"))),
  bucketMinutes: v.optional(v.number()),
  avg: v.optional(v.number()),
  min: v.optional(v.number()),
  max: v.optional(v.number()),
  last: v.optional(v.number()),
  count: v.optional(v.number()),
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getTimeSeries = query({
  args: {
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  returns: v.object({
    points: v.array(timeSeriesPointValidator),
    nextCursor: v.union(v.string(), v.null()),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.dataSourceId);
    if (!source) {
      return { points: [], nextCursor: null, hasMore: false };
    }

    const limit = Math.min(args.limit ?? 500, MAX_QUERY_LIMIT);
    const order = args.order ?? "asc";
    const cursor = args.cursor ? Number(args.cursor) : undefined;

    const points = await getPolicyAwarePointsForSource(ctx.db, {
      dataSourceId: source._id,
      userId: source.userId,
      provider: source.provider,
      seriesType: args.seriesType,
      startDate: args.startDate,
      endDate: args.endDate,
      limit: limit + 2,
      order,
    });

    const filtered =
      cursor === undefined
        ? points
        : points.filter((point) =>
            order === "asc" ? point.timestamp > cursor : point.timestamp < cursor,
          );

    const hasMore = filtered.length > limit;
    const items = hasMore ? filtered.slice(0, limit) : filtered;
    const nextCursor =
      hasMore && items.length > 0 ? String(items[items.length - 1].timestamp) : null;

    return {
      points: items,
      nextCursor,
      hasMore,
    };
  },
});

export const getTimeSeriesForUser = query({
  args: {
    userId: v.string(),
    seriesType: v.string(),
    startDate: v.number(),
    endDate: v.number(),
    limit: v.optional(v.number()),
  },
  returns: v.array(timeSeriesPointValidator),
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 500, MAX_QUERY_LIMIT);

    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();

    const points: TimeSeriesPoint[] = [];
    for (const source of sources) {
      points.push(
        ...(await getPolicyAwarePointsForSource(ctx.db, {
          dataSourceId: source._id,
          userId: source.userId,
          provider: source.provider,
          seriesType: args.seriesType,
          startDate: args.startDate,
          endDate: args.endDate,
          limit,
          order: "asc",
        })),
      );
    }

    points.sort((a, b) => a.timestamp - b.timestamp);
    return points.slice(0, limit);
  },
});

export const getLatestDataPoint = query({
  args: {
    userId: v.string(),
    seriesType: v.string(),
  },
  returns: v.union(
    v.object({
      timestamp: v.number(),
      value: v.number(),
      provider: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const sources = await ctx.db
      .query("dataSources")
      .withIndex("by_user_provider", (idx) => idx.eq("userId", args.userId))
      .collect();

    let latest: { timestamp: number; value: number; provider: string } | null = null;

    for (const source of sources) {
      const rawPoint = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) =>
          idx.eq("dataSourceId", source._id).eq("seriesType", args.seriesType),
        )
        .order("desc")
        .first();

      const rollupPoint = await ctx.db
        .query("timeSeriesRollups")
        .withIndex("by_source_type_bucket", (idx) =>
          idx.eq("dataSourceId", source._id).eq("seriesType", args.seriesType),
        )
        .order("desc")
        .first();

      const rawCandidate = rawPoint
        ? {
            timestamp: rawPoint.recordedAt,
            value: rawPoint.value,
            provider: source.provider,
          }
        : null;
      const rollupCandidate = rollupPoint
        ? {
            timestamp: rollupPoint.lastRecordedAt,
            value: rollupPoint.last,
            provider: source.provider,
          }
        : null;
      const candidate =
        rawCandidate === null
          ? rollupCandidate
          : rollupCandidate === null
            ? rawCandidate
            : rawCandidate.timestamp >= rollupCandidate.timestamp
              ? rawCandidate
              : rollupCandidate;

      if (candidate && (latest === null || candidate.timestamp > latest.timestamp)) {
        latest = candidate;
      }
    }

    return latest;
  },
});

export const getAvailableSeriesTypes = query({
  args: { userId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const states = await ctx.db
      .query("timeSeriesSeriesState")
      .withIndex("by_user", (idx) => idx.eq("userId", args.userId))
      .collect();

    return Array.from(new Set(states.map((state) => state.seriesType))).sort();
  },
});

export const getTimeSeriesPolicyConfiguration = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const settings = await getTimeSeriesPolicySettings(ctx.db);
    const rules = await ctx.db.query("timeSeriesPolicyRules").collect();

    return {
      maintenance: {
        enabled: settings.maintenanceEnabled,
        intervalMs: settings.maintenanceIntervalMs,
      },
      defaultRules: formatPolicyRulesForResponse(
        rules.filter(
          (rule) =>
            rule.policySetKind === "default" && rule.policySetKey === DEFAULT_POLICY_SET_KEY,
        ),
      ),
      presets: groupPolicyRulesByPreset(rules.filter((rule) => rule.policySetKind === "preset")),
    };
  },
});

export const getUserTimeSeriesPolicyPreset = query({
  args: {
    userId: v.string(),
  },
  returns: v.union(
    v.object({
      userId: v.string(),
      presetKey: v.string(),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query("timeSeriesPolicyAssignments")
      .withIndex("by_user", (idx) => idx.eq("userId", args.userId))
      .first();

    if (!assignment) {
      return null;
    }

    return {
      userId: assignment.userId,
      presetKey: assignment.presetKey,
      updatedAt: assignment.updatedAt,
    };
  },
});

export const getEffectiveTimeSeriesPolicy = query({
  args: {
    userId: v.string(),
    provider: providerName,
    seriesType: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const effective = await resolveEffectivePolicy(
      ctx.db,
      args.userId,
      args.provider,
      args.seriesType,
    );

    return {
      provider: args.provider,
      seriesType: args.seriesType,
      sourceKind: effective.sourceKind,
      sourceKey: effective.sourceKey,
      matchedScope: effective.matchedScope,
      tiers: effective.tiers.map(formatTierForResponse),
    };
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const replaceTimeSeriesPolicyConfiguration = mutation({
  args: {
    defaultRules: v.array(policyRuleInputValidator),
    presets: v.optional(v.array(policyPresetInputValidator)),
    maintenance: v.optional(maintenanceInputValidator),
  },
  returns: v.object({
    defaultRulesStored: v.number(),
    presetsStored: v.number(),
  }),
  handler: async (ctx, args) => {
    const normalizedDefaultRules = normalizeTimeSeriesPolicyRuleInputs(
      args.defaultRules as TimeSeriesPolicyRuleInput[],
    );
    const presetKeys = new Set<string>();
    const normalizedPresets = (args.presets ?? []).map((preset) => {
      if (!preset.key.trim()) {
        throw new Error("Preset keys must not be empty");
      }
      if (preset.key === DEFAULT_POLICY_SET_KEY) {
        throw new Error(`Preset key "${DEFAULT_POLICY_SET_KEY}" is reserved`);
      }
      if (presetKeys.has(preset.key)) {
        throw new Error(`Duplicate time-series policy preset key "${preset.key}"`);
      }
      presetKeys.add(preset.key);

      return {
        key: preset.key,
        rules: normalizeTimeSeriesPolicyRuleInputs(preset.rules as TimeSeriesPolicyRuleInput[]),
      };
    });

    const existingRules = await ctx.db.query("timeSeriesPolicyRules").collect();
    for (const rule of existingRules) {
      await ctx.db.delete(rule._id);
    }

    const updatedAt = Date.now();
    for (const rule of normalizedDefaultRules) {
      await ctx.db.insert("timeSeriesPolicyRules", {
        policySetKind: "default",
        policySetKey: DEFAULT_POLICY_SET_KEY,
        scopeKey: createTimeSeriesPolicyScopeKey(rule.provider, rule.seriesType),
        provider: rule.provider,
        seriesType: rule.seriesType,
        tiers: rule.tiers,
        updatedAt,
      });
    }

    for (const preset of normalizedPresets) {
      for (const rule of preset.rules) {
        await ctx.db.insert("timeSeriesPolicyRules", {
          policySetKind: "preset",
          policySetKey: preset.key,
          scopeKey: createTimeSeriesPolicyScopeKey(rule.provider, rule.seriesType),
          provider: rule.provider,
          seriesType: rule.seriesType,
          tiers: rule.tiers,
          updatedAt,
        });
      }
    }

    await upsertTimeSeriesPolicySettings(ctx, args.maintenance);
    await markAllSeriesStateDue(ctx, updatedAt);
    await ensureTimeSeriesMaintenanceScheduled(ctx);

    return {
      defaultRulesStored: normalizedDefaultRules.length,
      presetsStored: normalizedPresets.reduce((sum, preset) => sum + preset.rules.length, 0),
    };
  },
});

export const setUserTimeSeriesPolicyPreset = mutation({
  args: {
    userId: v.string(),
    presetKey: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("timeSeriesPolicyAssignments")
      .withIndex("by_user", (idx) => idx.eq("userId", args.userId))
      .first();

    if (args.presetKey === null) {
      if (existing) {
        await ctx.db.delete(existing._id);
      }
      await markSeriesStateDueForUser(ctx, args.userId, Date.now());
      await ensureTimeSeriesMaintenanceScheduled(ctx);
      return null;
    }

    const presetKey = args.presetKey;
    const presetRules = await ctx.db
      .query("timeSeriesPolicyRules")
      .withIndex("by_set", (idx) => idx.eq("policySetKind", "preset").eq("policySetKey", presetKey))
      .take(1);
    if (presetRules.length === 0) {
      throw new Error(`Time-series policy preset "${presetKey}" does not exist`);
    }

    const patch = {
      userId: args.userId,
      presetKey,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("timeSeriesPolicyAssignments", patch);
    }

    await markSeriesStateDueForUser(ctx, args.userId, Date.now());
    await ensureTimeSeriesMaintenanceScheduled(ctx);
    return null;
  },
});

export const storeDataPoint = internalMutation({
  args: {
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(),
    recordedAt: v.number(),
    value: v.number(),
    externalId: v.optional(v.string()),
  },
  returns: v.union(v.id("dataPoints"), v.null()),
  handler: async (ctx, args) => {
    const result = await storePointsWithPolicy(ctx, {
      dataSourceId: args.dataSourceId,
      seriesType: args.seriesType,
      points: [
        {
          recordedAt: args.recordedAt,
          value: args.value,
          externalId: args.externalId,
        },
      ],
    });

    return result.lastRawId;
  },
});

export const storeBatch = internalMutation({
  args: {
    dataSourceId: v.id("dataSources"),
    seriesType: v.string(),
    points: v.array(
      v.object({
        recordedAt: v.number(),
        value: v.number(),
        externalId: v.optional(v.string()),
      }),
    ),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const result = await storePointsWithPolicy(ctx, args);
    return result.processedCount;
  },
});

export const runTimeSeriesMaintenance = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const settingsDoc = await ensureTimeSeriesPolicySettingsDoc(ctx.db);
    const now = Date.now();

    if (!settingsDoc.maintenanceEnabled) {
      await ctx.db.patch(settingsDoc._id, {
        scheduledAt: undefined,
        lastRunAt: now,
        lastError: undefined,
        updatedAt: now,
      });
      return null;
    }

    await ctx.db.patch(settingsDoc._id, {
      scheduledAt: undefined,
      lastRunAt: now,
      lastError: undefined,
      updatedAt: now,
    });

    let lastError: string | undefined;
    const dueStates = await ctx.db
      .query("timeSeriesSeriesState")
      .withIndex("by_next_maintenance", (idx) => idx.lte("nextMaintenanceAt", now))
      .take(MAINTENANCE_BATCH_SIZE);

    for (const state of dueStates) {
      try {
        await maintainSeriesState(ctx.db, state, now);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    const refreshed = await ensureTimeSeriesPolicySettingsDoc(ctx.db);
    const hasBacklog = dueStates.length === MAINTENANCE_BATCH_SIZE;
    const delayMs = hasBacklog
      ? Math.min(refreshed.maintenanceIntervalMs, 60 * 1000)
      : refreshed.maintenanceIntervalMs;
    const scheduledAt = now + delayMs;

    await ctx.scheduler.runAfter(delayMs, internal.dataPoints.runTimeSeriesMaintenance, {});
    await ctx.db.patch(refreshed._id, {
      scheduledAt,
      lastRunAt: now,
      lastError,
      updatedAt: now,
    });

    return null;
  },
});

export const deleteByDataSource = internalMutation({
  args: { dataSourceId: v.id("dataSources") },
  returns: v.null(),
  handler: async (ctx, args) => {
    let rawBatch = await ctx.db
      .query("dataPoints")
      .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", args.dataSourceId))
      .take(1000);

    while (rawBatch.length > 0) {
      for (const point of rawBatch) {
        await ctx.db.delete(point._id);
      }
      rawBatch = await ctx.db
        .query("dataPoints")
        .withIndex("by_source_type_time", (idx) => idx.eq("dataSourceId", args.dataSourceId))
        .take(1000);
    }

    let rollupBatch = await ctx.db
      .query("timeSeriesRollups")
      .withIndex("by_source_type_bucket", (idx) => idx.eq("dataSourceId", args.dataSourceId))
      .take(1000);

    while (rollupBatch.length > 0) {
      for (const rollup of rollupBatch) {
        await ctx.db.delete(rollup._id);
      }
      rollupBatch = await ctx.db
        .query("timeSeriesRollups")
        .withIndex("by_source_type_bucket", (idx) => idx.eq("dataSourceId", args.dataSourceId))
        .take(1000);
    }

    const state = await ctx.db
      .query("timeSeriesSeriesState")
      .withIndex("by_source_series", (idx) => idx.eq("dataSourceId", args.dataSourceId))
      .collect();
    for (const doc of state) {
      await ctx.db.delete(doc._id);
    }

    return null;
  },
});

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

async function getTimeSeriesPolicySettings(db: {
  query: DatabaseReader["query"];
}): Promise<PolicySettingsDoc> {
  const existing = await db
    .query("timeSeriesPolicySettings")
    .withIndex("by_key", (idx) => idx.eq("key", MAINTENANCE_SETTINGS_KEY))
    .first();

  return (
    existing ?? {
      key: MAINTENANCE_SETTINGS_KEY,
      maintenanceEnabled: true,
      maintenanceIntervalMs: DEFAULT_MAINTENANCE_INTERVAL_MS,
      updatedAt: 0,
    }
  );
}

async function ensureTimeSeriesPolicySettingsDoc(db: {
  query: DatabaseWriter["query"];
  insert: DatabaseWriter["insert"];
  get: DatabaseWriter["get"];
}) {
  const existing = await db
    .query("timeSeriesPolicySettings")
    .withIndex("by_key", (idx) => idx.eq("key", MAINTENANCE_SETTINGS_KEY))
    .first();
  if (existing) {
    return existing;
  }

  const id = await db.insert("timeSeriesPolicySettings", {
    key: MAINTENANCE_SETTINGS_KEY,
    maintenanceEnabled: true,
    maintenanceIntervalMs: DEFAULT_MAINTENANCE_INTERVAL_MS,
    updatedAt: Date.now(),
  });
  const inserted = await db.get(id);
  if (!inserted) {
    throw new Error("Failed to create time-series policy settings");
  }
  return inserted;
}

async function upsertTimeSeriesPolicySettings(
  ctx: {
    db: Pick<DatabaseWriter, "get" | "insert" | "patch" | "query">;
  },
  maintenance?: {
    enabled?: boolean;
    interval?: DurationInput;
  },
) {
  const existing = await ensureTimeSeriesPolicySettingsDoc(ctx.db);
  const patch = {
    maintenanceEnabled: maintenance?.enabled ?? existing.maintenanceEnabled,
    maintenanceIntervalMs:
      maintenance?.interval !== undefined
        ? parseDurationInput(maintenance.interval, "maintenance.interval")
        : existing.maintenanceIntervalMs,
    updatedAt: Date.now(),
  };

  await ctx.db.patch(existing._id, patch);
}

async function resolveEffectivePolicy(
  db: {
    query: TimeSeriesReadDb["query"];
  },
  userId: string,
  provider: string,
  seriesType: string,
): Promise<EffectivePolicy> {
  const assignment = await db
    .query("timeSeriesPolicyAssignments")
    .withIndex("by_user", (idx) => idx.eq("userId", userId))
    .first();

  if (assignment) {
    const presetRules = (await db
      .query("timeSeriesPolicyRules")
      .withIndex("by_set", (idx) =>
        idx.eq("policySetKind", "preset").eq("policySetKey", assignment.presetKey),
      )
      .collect()) as StoredPolicyRule[];
    const presetMatch = resolveScopedPolicyRule(presetRules, provider, seriesType);

    if (presetMatch) {
      return {
        provider: presetMatch.provider,
        seriesType: presetMatch.seriesType,
        tiers: presetMatch.tiers,
        sourceKind: "preset",
        sourceKey: assignment.presetKey,
        matchedScope: inferTimeSeriesPolicyScope(presetMatch.provider, presetMatch.seriesType),
      };
    }
  }

  const defaultRules = (await db
    .query("timeSeriesPolicyRules")
    .withIndex("by_set", (idx) =>
      idx.eq("policySetKind", "default").eq("policySetKey", DEFAULT_POLICY_SET_KEY),
    )
    .collect()) as StoredPolicyRule[];
  const defaultMatch = resolveScopedPolicyRule(defaultRules, provider, seriesType);

  if (defaultMatch) {
    return {
      provider: defaultMatch.provider,
      seriesType: defaultMatch.seriesType,
      tiers: defaultMatch.tiers,
      sourceKind: "default",
      sourceKey: DEFAULT_POLICY_SET_KEY,
      matchedScope: inferTimeSeriesPolicyScope(defaultMatch.provider, defaultMatch.seriesType),
    };
  }

  return {
    tiers: buildBuiltinFullTiers(),
    sourceKind: "builtin",
    sourceKey: null,
    matchedScope: "default",
  };
}

function formatTierForResponse(tier: NormalizedTimeSeriesTier) {
  if (tier.kind === "raw") {
    return {
      kind: "raw",
      fromAgeMs: tier.fromAgeMs,
      toAgeMs: tier.toAgeMs,
    };
  }

  return {
    kind: "rollup",
    fromAgeMs: tier.fromAgeMs,
    toAgeMs: tier.toAgeMs,
    bucketMs: tier.bucketMs,
    aggregations: tier.aggregations,
  };
}

function formatPolicyRulesForResponse(rules: StoredPolicyRule[]) {
  return rules
    .map((rule) => ({
      _id: rule._id,
      provider: rule.provider,
      seriesType: rule.seriesType,
      scope: inferTimeSeriesPolicyScope(rule.provider, rule.seriesType),
      policySetKind: rule.policySetKind,
      policySetKey: rule.policySetKey,
      tiers: rule.tiers.map(formatTierForResponse),
      updatedAt: rule.updatedAt,
    }))
    .sort(comparePolicyScopes);
}

function groupPolicyRulesByPreset(rules: StoredPolicyRule[]) {
  const grouped = new Map<string, StoredPolicyRule[]>();
  for (const rule of rules) {
    const existing = grouped.get(rule.policySetKey) ?? [];
    existing.push(rule);
    grouped.set(rule.policySetKey, existing);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, groupedRules]) => ({
      key,
      rules: formatPolicyRulesForResponse(groupedRules),
    }));
}

function policyRequiresMaintenance(tiers: NormalizedTimeSeriesTier[]) {
  const rawTier = getRawTier(tiers);
  if (!rawTier) {
    return true;
  }
  if (tiers.length > 1) {
    return true;
  }
  return rawTier.toAgeMs !== null;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

async function storePointsWithPolicy(
  ctx: TimeSeriesMutationContext,
  args: {
    dataSourceId: Id<"dataSources">;
    seriesType: string;
    points: StoredPointInput[];
  },
) {
  const dataSource = await ctx.db.get(args.dataSourceId);
  if (!dataSource) {
    throw new Error(`Data source ${args.dataSourceId} not found`);
  }

  const effectivePolicy = await resolveEffectivePolicy(
    ctx.db,
    dataSource.userId,
    dataSource.provider,
    args.seriesType,
  );
  const settings = await getTimeSeriesPolicySettings(ctx.db);
  const now = Date.now();
  const points = dedupeIncomingPoints(args.points);

  const rawPoints: StoredPointInput[] = [];
  const rollupGroups = new Map<
    string,
    { bucketMs: number; bucketStart: number; stats: AggregatedStats }
  >();

  for (const point of points) {
    const ageMs = Math.max(0, now - point.recordedAt);
    const destinationTier = findTierForAge(effectivePolicy.tiers, ageMs);
    if (!destinationTier) {
      continue;
    }

    if (destinationTier.kind === "raw") {
      rawPoints.push(point);
      continue;
    }

    addRawPointToRollupGroup(rollupGroups, point, destinationTier.bucketMs);
  }

  let lastRawId: Id<"dataPoints"> | null = null;
  if (rawPoints.length > 0) {
    lastRawId = await upsertRawPoints(ctx.db, args.dataSourceId, args.seriesType, rawPoints);
  }
  if (rollupGroups.size > 0) {
    await upsertRollupStatsGroups(
      ctx.db,
      args.dataSourceId,
      args.seriesType,
      rollupGroups.values(),
    );
  }

  await upsertSeriesState(ctx.db, {
    dataSourceId: dataSource._id,
    connectionId: dataSource.connectionId,
    userId: dataSource.userId,
    provider: dataSource.provider,
    seriesType: args.seriesType,
    latestRecordedAt: points.length > 0 ? points[points.length - 1].recordedAt : now,
    nextMaintenanceAt: policyRequiresMaintenance(effectivePolicy.tiers)
      ? now + settings.maintenanceIntervalMs
      : now + LONG_IDLE_MAINTENANCE_MS,
  });

  if (policyRequiresMaintenance(effectivePolicy.tiers)) {
    await maintainSeriesState(
      ctx.db,
      {
        dataSourceId: dataSource._id,
        connectionId: dataSource.connectionId,
        userId: dataSource.userId,
        provider: dataSource.provider,
        seriesType: args.seriesType,
      },
      now,
    );
    await ensureTimeSeriesMaintenanceScheduled(ctx);
  }

  return {
    processedCount: points.length,
    lastRawId,
  };
}

function dedupeIncomingPoints(points: StoredPointInput[]) {
  const deduped = new Map<number, StoredPointInput>();
  for (const point of points) {
    deduped.set(point.recordedAt, point);
  }
  return Array.from(deduped.values()).sort((a, b) => a.recordedAt - b.recordedAt);
}

async function upsertRawPoints(
  db: TimeSeriesWriteDb,
  dataSourceId: Id<"dataSources">,
  seriesType: string,
  points: StoredPointInput[],
) {
  let lastId: Id<"dataPoints"> | null = null;

  for (const point of points) {
    const existing = await db
      .query("dataPoints")
      .withIndex("by_source_type_time", (idx) =>
        idx
          .eq("dataSourceId", dataSourceId)
          .eq("seriesType", seriesType)
          .eq("recordedAt", point.recordedAt),
      )
      .first();

    if (existing) {
      await db.patch(existing._id, {
        value: point.value,
        externalId: point.externalId,
      });
      lastId = existing._id;
    } else {
      lastId = await db.insert("dataPoints", {
        dataSourceId,
        seriesType,
        recordedAt: point.recordedAt,
        value: point.value,
        externalId: point.externalId,
      });
    }
  }

  return lastId;
}

function addRawPointToRollupGroup(
  groups: Map<string, { bucketMs: number; bucketStart: number; stats: AggregatedStats }>,
  point: StoredPointInput,
  bucketMs: number,
) {
  const bucketStart = getBucketStart(point.recordedAt, bucketMs);
  const key = `${bucketMs}:${bucketStart}`;
  const existing = groups.get(key);
  const stats = aggregateRawPoints([
    {
      recordedAt: point.recordedAt,
      value: point.value,
    },
  ]);

  if (existing) {
    existing.stats = combineAggregatedStats([existing.stats, stats]);
  } else {
    groups.set(key, {
      bucketMs,
      bucketStart,
      stats,
    });
  }
}

async function upsertRollupStatsGroups(
  db: TimeSeriesWriteDb,
  dataSourceId: Id<"dataSources">,
  seriesType: string,
  groups: Iterable<{ bucketMs: number; bucketStart: number; stats: AggregatedStats }>,
) {
  for (const group of groups) {
    const existing = await db
      .query("timeSeriesRollups")
      .withIndex("by_source_type_bucket_size", (idx) =>
        idx
          .eq("dataSourceId", dataSourceId)
          .eq("seriesType", seriesType)
          .eq("bucketMs", group.bucketMs)
          .eq("bucketStart", group.bucketStart),
      )
      .first();

    const combined = existing
      ? combineAggregatedStats([rollupDocToStats(existing), group.stats])
      : group.stats;
    const patch = {
      dataSourceId,
      seriesType,
      bucketMs: group.bucketMs,
      bucketStart: group.bucketStart,
      bucketEnd: getBucketEnd(group.bucketStart, group.bucketMs),
      avg: combined.avg,
      min: combined.min,
      max: combined.max,
      last: combined.last,
      lastRecordedAt: combined.lastRecordedAt,
      count: combined.count,
      updatedAt: Date.now(),
    };

    if (existing) {
      await db.patch(existing._id, patch);
    } else {
      await db.insert("timeSeriesRollups", patch);
    }
  }
}

async function upsertSeriesState(
  db: TimeSeriesWriteDb,
  args: {
    dataSourceId: Id<"dataSources">;
    connectionId?: Id<"connections">;
    userId: string;
    provider: Doc<"dataSources">["provider"];
    seriesType: string;
    latestRecordedAt: number;
    nextMaintenanceAt: number;
  },
) {
  const existing = await db
    .query("timeSeriesSeriesState")
    .withIndex("by_source_series", (idx) =>
      idx.eq("dataSourceId", args.dataSourceId).eq("seriesType", args.seriesType),
    )
    .first();

  const patch = {
    dataSourceId: args.dataSourceId,
    connectionId: args.connectionId,
    userId: args.userId,
    provider: args.provider,
    seriesType: args.seriesType,
    latestRecordedAt: existing
      ? Math.max(existing.latestRecordedAt, args.latestRecordedAt)
      : args.latestRecordedAt,
    lastIngestedAt: Date.now(),
    nextMaintenanceAt: args.nextMaintenanceAt,
    updatedAt: Date.now(),
  };

  if (existing) {
    await db.patch(existing._id, patch);
    return existing._id;
  }

  return await db.insert("timeSeriesSeriesState", patch);
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

async function ensureTimeSeriesMaintenanceScheduled(ctx: TimeSeriesMutationContext) {
  const settings = await ensureTimeSeriesPolicySettingsDoc(ctx.db);
  if (!settings.maintenanceEnabled) {
    return;
  }

  const now = Date.now();
  if (settings.scheduledAt !== undefined && settings.scheduledAt > now) {
    return;
  }

  const delayMs = settings.maintenanceIntervalMs;
  const scheduledAt = now + delayMs;
  await ctx.scheduler.runAfter(delayMs, internal.dataPoints.runTimeSeriesMaintenance, {});
  await ctx.db.patch(settings._id, {
    scheduledAt,
    updatedAt: now,
  });
}

async function markAllSeriesStateDue(ctx: TimeSeriesMutationContext, dueAt: number) {
  const states = await ctx.db.query("timeSeriesSeriesState").collect();

  for (const state of states) {
    await ctx.db.patch(state._id, {
      nextMaintenanceAt: dueAt,
      updatedAt: Date.now(),
    });
  }
}

async function markSeriesStateDueForUser(
  ctx: TimeSeriesMutationContext,
  userId: string,
  dueAt: number,
) {
  const batch = await ctx.db
    .query("timeSeriesSeriesState")
    .withIndex("by_user", (idx) => idx.eq("userId", userId))
    .collect();

  for (const state of batch) {
    await ctx.db.patch(state._id, {
      nextMaintenanceAt: dueAt,
      updatedAt: Date.now(),
    });
  }
}

async function maintainSeriesState(
  db: TimeSeriesWriteDb,
  state: Pick<
    StoredSeriesState,
    "connectionId" | "dataSourceId" | "userId" | "provider" | "seriesType"
  >,
  now: number,
) {
  const source = await db.get(state.dataSourceId);
  const storedState = await db
    .query("timeSeriesSeriesState")
    .withIndex("by_source_series", (idx) =>
      idx.eq("dataSourceId", state.dataSourceId).eq("seriesType", state.seriesType),
    )
    .first();

  if (!source || !storedState) {
    if (storedState) {
      await db.delete(storedState._id);
    }
    return;
  }

  const effective = await resolveEffectivePolicy(
    db,
    storedState.userId,
    storedState.provider,
    storedState.seriesType,
  );
  await compactRawPoints(db, storedState, effective.tiers, now);
  await compactRollupPoints(db, storedState, effective.tiers, now);

  const stillHasData = await sourceSeriesHasData(
    db,
    storedState.dataSourceId,
    storedState.seriesType,
  );
  if (!stillHasData) {
    await db.delete(storedState._id);
    return;
  }

  const settings = await getTimeSeriesPolicySettings(db);
  await db.patch(storedState._id, {
    nextMaintenanceAt: policyRequiresMaintenance(effective.tiers)
      ? now + settings.maintenanceIntervalMs
      : now + LONG_IDLE_MAINTENANCE_MS,
    lastMaintenanceAt: now,
    updatedAt: now,
  });
}

async function compactRawPoints(
  db: TimeSeriesWriteDb,
  state: StoredSeriesState,
  tiers: NormalizedTimeSeriesTier[],
  now: number,
) {
  const rawTier = getRawTier(tiers);
  const rawCutoff = rawTier?.toAgeMs ?? null;
  const query =
    rawCutoff === null
      ? rawTier
        ? []
        : await db
            .query("dataPoints")
            .withIndex("by_source_type_time", (idx) =>
              idx.eq("dataSourceId", state.dataSourceId).eq("seriesType", state.seriesType),
            )
            .take(MAINTENANCE_POINT_BATCH_SIZE)
      : await db
          .query("dataPoints")
          .withIndex("by_source_type_time", (idx) =>
            idx
              .eq("dataSourceId", state.dataSourceId)
              .eq("seriesType", state.seriesType)
              .lt("recordedAt", now - rawCutoff),
          )
          .take(MAINTENANCE_POINT_BATCH_SIZE);

  if (query.length === 0) {
    return;
  }

  const rollupGroups = new Map<
    string,
    { bucketMs: number; bucketStart: number; stats: AggregatedStats }
  >();
  const toDelete: Id<"dataPoints">[] = [];

  for (const point of query as Doc<"dataPoints">[]) {
    const ageMs = Math.max(0, now - point.recordedAt);
    const destinationTier = findTierForAge(tiers, ageMs);
    if (!destinationTier) {
      toDelete.push(point._id);
      continue;
    }

    if (destinationTier.kind === "raw") {
      continue;
    }

    const bucketStart = getBucketStart(point.recordedAt, destinationTier.bucketMs);
    const bucketEnd = getBucketEnd(bucketStart, destinationTier.bucketMs);
    if (bucketEnd > now - destinationTier.fromAgeMs) {
      continue;
    }

    addRawPointToRollupGroup(rollupGroups, point, destinationTier.bucketMs);
    toDelete.push(point._id);
  }

  if (rollupGroups.size > 0) {
    await upsertRollupStatsGroups(db, state.dataSourceId, state.seriesType, rollupGroups.values());
  }
  for (const pointId of toDelete) {
    await db.delete(pointId);
  }
}

async function compactRollupPoints(
  db: TimeSeriesWriteDb,
  state: StoredSeriesState,
  tiers: NormalizedTimeSeriesTier[],
  now: number,
) {
  const rollups = await db
    .query("timeSeriesRollups")
    .withIndex("by_source_type_bucket", (idx) =>
      idx.eq("dataSourceId", state.dataSourceId).eq("seriesType", state.seriesType),
    )
    .take(MAINTENANCE_ROLLUP_BATCH_SIZE);

  if (rollups.length === 0) {
    return;
  }

  const destinationGroups = new Map<
    string,
    { bucketMs: number; bucketStart: number; stats: AggregatedStats }
  >();
  const toDelete: Id<"timeSeriesRollups">[] = [];

  for (const rollup of rollups as StoredRollup[]) {
    const ageMs = Math.max(0, now - rollup.bucketEnd);
    const destinationTier = findTierForAge(tiers, ageMs);

    if (!destinationTier) {
      toDelete.push(rollup._id);
      continue;
    }

    if (destinationTier.kind === "raw") {
      continue;
    }

    const destinationBucketStart = getBucketStart(rollup.bucketStart, destinationTier.bucketMs);
    const destinationBucketEnd = getBucketEnd(destinationBucketStart, destinationTier.bucketMs);

    if (destinationTier.bucketMs === rollup.bucketMs) {
      continue;
    }
    if (destinationBucketEnd > now - destinationTier.fromAgeMs) {
      continue;
    }

    addStatsToRollupGroup(
      destinationGroups,
      destinationTier.bucketMs,
      destinationBucketStart,
      rollupDocToStats(rollup),
    );
    toDelete.push(rollup._id);
  }

  if (destinationGroups.size > 0) {
    await upsertRollupStatsGroups(
      db,
      state.dataSourceId,
      state.seriesType,
      destinationGroups.values(),
    );
  }
  for (const rollupId of toDelete) {
    await db.delete(rollupId);
  }
}

async function sourceSeriesHasData(
  db: Pick<TimeSeriesWriteDb, "query">,
  dataSourceId: Id<"dataSources">,
  seriesType: string,
) {
  const raw = await db
    .query("dataPoints")
    .withIndex("by_source_type_time", (idx) =>
      idx.eq("dataSourceId", dataSourceId).eq("seriesType", seriesType),
    )
    .first();
  if (raw) {
    return true;
  }

  const rollup = await db
    .query("timeSeriesRollups")
    .withIndex("by_source_type_bucket", (idx) =>
      idx.eq("dataSourceId", dataSourceId).eq("seriesType", seriesType),
    )
    .first();
  return rollup !== null;
}

function aggregateRawPoints(points: Array<{ recordedAt: number; value: number }>): AggregatedStats {
  const values = points.map((point) => point.value);
  const lastPoint = points.reduce((latest, point) =>
    point.recordedAt >= latest.recordedAt ? point : latest,
  );

  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    last: lastPoint.value,
    lastRecordedAt: lastPoint.recordedAt,
    count: points.length,
  };
}

function combineAggregatedStats(stats: AggregatedStats[]) {
  const totalCount = stats.reduce((sum, item) => sum + item.count, 0);
  const latest = stats.reduce((current, item) =>
    item.lastRecordedAt >= current.lastRecordedAt ? item : current,
  );

  return {
    avg: stats.reduce((sum, item) => sum + item.avg * item.count, 0) / totalCount,
    min: Math.min(...stats.map((item) => item.min)),
    max: Math.max(...stats.map((item) => item.max)),
    last: latest.last,
    lastRecordedAt: latest.lastRecordedAt,
    count: totalCount,
  };
}

function rollupDocToStats(rollup: StoredRollup): AggregatedStats {
  return {
    avg: rollup.avg,
    min: rollup.min,
    max: rollup.max,
    last: rollup.last,
    lastRecordedAt: rollup.lastRecordedAt,
    count: rollup.count,
  };
}

function addStatsToRollupGroup(
  groups: Map<string, { bucketMs: number; bucketStart: number; stats: AggregatedStats }>,
  bucketMs: number,
  bucketStart: number,
  stats: AggregatedStats,
) {
  const key = `${bucketMs}:${bucketStart}`;
  const existing = groups.get(key);
  if (existing) {
    existing.stats = combineAggregatedStats([existing.stats, stats]);
    return;
  }

  groups.set(key, {
    bucketMs,
    bucketStart,
    stats,
  });
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

async function getPolicyAwarePointsForSource(
  db: TimeSeriesReadDb,
  args: {
    dataSourceId: Id<"dataSources">;
    userId: string;
    provider: Doc<"dataSources">["provider"];
    seriesType: string;
    startDate: number;
    endDate: number;
    limit: number;
    order: "asc" | "desc";
  },
) {
  const effective = await resolveEffectivePolicy(db, args.userId, args.provider, args.seriesType);
  const now = Date.now();
  const points: TimeSeriesPoint[] = [];

  for (const tier of effective.tiers) {
    const interval = getAbsoluteTimeRangeForTier(tier, now, args.startDate, args.endDate);
    if (!interval) {
      continue;
    }

    const preferred =
      tier.kind === "raw"
        ? await queryRawPoints(db, {
            dataSourceId: args.dataSourceId,
            seriesType: args.seriesType,
            startDate: interval.start,
            endDate: interval.end,
            limit: args.limit + 1,
            order: args.order,
          })
        : await queryRollupPoints(db, {
            dataSourceId: args.dataSourceId,
            seriesType: args.seriesType,
            bucketMs: tier.bucketMs,
            startDate: interval.start,
            endDate: interval.end,
            limit: args.limit + 1,
            order: args.order,
            aggregations: tier.aggregations,
          });

    if (preferred.length > 0) {
      points.push(...preferred);
      continue;
    }

    points.push(
      ...(await queryFallbackPoints(db, {
        dataSourceId: args.dataSourceId,
        seriesType: args.seriesType,
        startDate: interval.start,
        endDate: interval.end,
        limit: args.limit + 1,
        order: args.order,
      })),
    );
  }

  points.sort((a, b) =>
    args.order === "asc" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp,
  );
  return points.slice(0, args.limit);
}

function getAbsoluteTimeRangeForTier(
  tier: NormalizedTimeSeriesTier,
  now: number,
  startDate: number,
  endDate: number,
) {
  const absoluteStart =
    tier.toAgeMs === null ? startDate : Math.max(startDate, now - tier.toAgeMs + 1);
  const absoluteEnd = Math.min(endDate, now - tier.fromAgeMs);

  if (absoluteStart > absoluteEnd) {
    return null;
  }

  return {
    start: absoluteStart,
    end: absoluteEnd,
  };
}

async function queryRawPoints(
  db: Pick<TimeSeriesReadDb, "query">,
  args: {
    dataSourceId: Id<"dataSources">;
    seriesType: string;
    startDate: number;
    endDate: number;
    limit: number;
    order: "asc" | "desc";
  },
) {
  const raw = await db
    .query("dataPoints")
    .withIndex("by_source_type_time", (idx) =>
      idx
        .eq("dataSourceId", args.dataSourceId)
        .eq("seriesType", args.seriesType)
        .gte("recordedAt", args.startDate)
        .lte("recordedAt", args.endDate),
    )
    .order(args.order)
    .take(args.limit);

  return raw.map((point: Doc<"dataPoints">) => ({
    timestamp: point.recordedAt,
    value: point.value,
    resolution: "raw" as const,
  }));
}

async function queryRollupPoints(
  db: Pick<TimeSeriesReadDb, "query">,
  args: {
    dataSourceId: Id<"dataSources">;
    seriesType: string;
    bucketMs: number;
    startDate: number;
    endDate: number;
    limit: number;
    order: "asc" | "desc";
    aggregations: readonly TimeSeriesAggregation[];
  },
) {
  const rows = await db
    .query("timeSeriesRollups")
    .withIndex("by_source_type_bucket_size", (idx) =>
      idx
        .eq("dataSourceId", args.dataSourceId)
        .eq("seriesType", args.seriesType)
        .eq("bucketMs", args.bucketMs)
        .gte("bucketStart", Math.max(0, args.startDate - args.bucketMs))
        .lte("bucketStart", args.endDate),
    )
    .order(args.order)
    .take(args.limit);

  return rows
    .filter(
      (row: StoredRollup) => row.bucketEnd >= args.startDate && row.bucketStart <= args.endDate,
    )
    .map((row: StoredRollup) => toRollupPoint(row, args.aggregations));
}

async function queryFallbackPoints(
  db: Pick<TimeSeriesReadDb, "query">,
  args: {
    dataSourceId: Id<"dataSources">;
    seriesType: string;
    startDate: number;
    endDate: number;
    limit: number;
    order: "asc" | "desc";
  },
) {
  const raw = await queryRawPoints(db, args);
  if (raw.length > 0) {
    return raw;
  }

  const rows = await db
    .query("timeSeriesRollups")
    .withIndex("by_source_type_bucket", (idx) =>
      idx
        .eq("dataSourceId", args.dataSourceId)
        .eq("seriesType", args.seriesType)
        .gte("bucketStart", Math.max(0, args.startDate - DAY_MS))
        .lte("bucketStart", args.endDate),
    )
    .take(args.limit * 4);

  rows.sort((a: StoredRollup, b: StoredRollup) =>
    a.bucketMs === b.bucketMs ? a.bucketStart - b.bucketStart : a.bucketMs - b.bucketMs,
  );

  const filtered = rows.filter(
    (row: StoredRollup) => row.bucketEnd >= args.startDate && row.bucketStart <= args.endDate,
  );
  return filtered.map((row: StoredRollup) =>
    toRollupPoint(row, normalizeAggregations(DEFAULT_TIME_SERIES_AGGREGATIONS)),
  );
}

function toRollupPoint(
  rollup: StoredRollup,
  aggregations: readonly TimeSeriesAggregation[],
): TimeSeriesPoint {
  return {
    timestamp: rollup.bucketStart,
    value: selectPrimaryRollupValue(rollup, aggregations),
    resolution: "rollup",
    bucketMinutes: Math.floor(rollup.bucketMs / (60 * 1000)),
    avg: rollup.avg,
    min: rollup.min,
    max: rollup.max,
    last: rollup.last,
    count: rollup.count,
  };
}

function selectPrimaryRollupValue(
  rollup: StoredRollup,
  aggregations: readonly TimeSeriesAggregation[],
) {
  if (aggregations.includes("avg")) {
    return rollup.avg;
  }
  if (aggregations.includes("last")) {
    return rollup.last;
  }
  if (aggregations.includes("max")) {
    return rollup.max;
  }
  if (aggregations.includes("min")) {
    return rollup.min;
  }
  return rollup.count;
}
