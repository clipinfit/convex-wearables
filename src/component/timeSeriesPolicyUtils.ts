import type { Doc } from "./_generated/dataModel";

export const DEFAULT_POLICY_SET_KEY = "__default__";
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_TIME_SERIES_AGGREGATIONS = ["avg", "min", "max", "last", "count"] as const;

export type DurationInput = string | number;
export type TimeSeriesAggregation = Doc<"timeSeriesPolicyRules">["tiers"][number] extends infer Tier
  ? Tier extends { aggregations: infer Aggregations }
    ? Aggregations extends Array<infer Aggregation>
      ? Aggregation
      : never
    : never
  : never;

export type TimeSeriesTierInput =
  | {
      kind: "raw";
      fromAge: DurationInput;
      toAge: DurationInput | null;
    }
  | {
      kind: "rollup";
      fromAge: DurationInput;
      toAge: DurationInput | null;
      bucket: DurationInput;
      aggregations?: TimeSeriesAggregation[];
    };

export type NormalizedTimeSeriesTier = Doc<"timeSeriesPolicyRules">["tiers"][number];

export type TimeSeriesPolicyRuleInput = {
  provider?: Doc<"timeSeriesPolicyRules">["provider"];
  seriesType?: string;
  tiers: TimeSeriesTierInput[];
};

const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
} as const;

export function parseDurationInput(input: DurationInput, label: string) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`${label} must be a non-negative duration`);
    }
    return Math.floor(input);
  }

  const trimmed = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `${label} must be a duration like "30m", "24h", "7d", or a numeric millisecond value`,
    );
  }

  const value = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_UNITS;
  return Math.floor(value * DURATION_UNITS[unit]);
}

export function createTimeSeriesPolicyScopeKey(provider?: string, seriesType?: string) {
  return `${provider ?? "*"}::${seriesType ?? "*"}`;
}

export function inferTimeSeriesPolicyScope(provider?: string, seriesType?: string) {
  if (provider && seriesType) {
    return "provider_series" as const;
  }
  if (seriesType) {
    return "series" as const;
  }
  if (provider) {
    return "provider" as const;
  }
  return "global" as const;
}

export function normalizeAggregations(aggregations?: readonly TimeSeriesAggregation[]) {
  const unique = new Set(aggregations ?? (DEFAULT_TIME_SERIES_AGGREGATIONS as readonly string[]));
  if (unique.size === 0) {
    throw new Error("Rollup tiers must include at least one aggregation");
  }
  return Array.from(unique) as TimeSeriesAggregation[];
}

export function normalizeTimeSeriesTierInputs(tiers: TimeSeriesTierInput[]) {
  if (tiers.length === 0) {
    throw new Error("A time-series policy rule must include at least one tier");
  }

  let rawTierCount = 0;
  const normalized = tiers.map((tier, index) => {
    const fromAgeMs = parseDurationInput(tier.fromAge, `tiers[${index}].fromAge`);
    const toAgeMs =
      tier.toAge === null ? null : parseDurationInput(tier.toAge, `tiers[${index}].toAge`);

    if (toAgeMs !== null && toAgeMs <= fromAgeMs) {
      throw new Error(`tiers[${index}] must have toAge greater than fromAge`);
    }

    if (tier.kind === "raw") {
      rawTierCount += 1;
      return {
        kind: "raw" as const,
        fromAgeMs,
        toAgeMs,
      };
    }

    const bucketMs = parseDurationInput(tier.bucket, `tiers[${index}].bucket`);
    if (bucketMs <= 0 || bucketMs % (60 * 1000) !== 0) {
      throw new Error(`tiers[${index}].bucket must be a positive whole-minute duration`);
    }

    return {
      kind: "rollup" as const,
      fromAgeMs,
      toAgeMs,
      bucketMs,
      aggregations: normalizeAggregations(tier.aggregations),
    };
  });

  if (normalized[0].fromAgeMs !== 0) {
    throw new Error("The first tier must start at age 0");
  }
  if (rawTierCount > 1) {
    throw new Error("Only one raw tier is supported in a single policy rule");
  }

  for (let index = 0; index < normalized.length - 1; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];

    if (current.toAgeMs === null) {
      throw new Error("Open-ended tiers must be the final tier");
    }
    if (next.fromAgeMs !== current.toAgeMs) {
      throw new Error("Policy tiers must be contiguous without gaps or overlap");
    }
  }

  return normalized;
}

export function normalizeTimeSeriesPolicyRuleInputs(rules: TimeSeriesPolicyRuleInput[]) {
  const seenScopes = new Set<string>();

  return rules.map((rule, index) => {
    const scopeKey = createTimeSeriesPolicyScopeKey(rule.provider, rule.seriesType);
    if (seenScopes.has(scopeKey)) {
      throw new Error(`Duplicate time-series policy rule scope "${scopeKey}" at index ${index}`);
    }
    seenScopes.add(scopeKey);

    return {
      provider: rule.provider,
      seriesType: rule.seriesType,
      tiers: normalizeTimeSeriesTierInputs(rule.tiers),
    };
  });
}

export function findTierForAge(tiers: NormalizedTimeSeriesTier[], ageMs: number) {
  return (
    tiers.find(
      (tier) => ageMs >= tier.fromAgeMs && (tier.toAgeMs === null || ageMs < tier.toAgeMs),
    ) ?? null
  );
}

export function getRawTier(tiers: NormalizedTimeSeriesTier[]) {
  return tiers.find((tier) => tier.kind === "raw") ?? null;
}

export function getRollupTiers(tiers: NormalizedTimeSeriesTier[]) {
  return tiers.filter((tier) => tier.kind === "rollup");
}

export function buildBuiltinFullTiers(): NormalizedTimeSeriesTier[] {
  return [
    {
      kind: "raw",
      fromAgeMs: 0,
      toAgeMs: null,
    },
  ];
}

export function resolveScopedPolicyRule<
  Rule extends {
    provider?: string;
    seriesType?: string;
  },
>(rules: Rule[], provider: string, seriesType: string) {
  return (
    rules.find((rule) => rule.provider === provider && rule.seriesType === seriesType) ??
    rules.find((rule) => rule.provider === undefined && rule.seriesType === seriesType) ??
    rules.find((rule) => rule.provider === provider && rule.seriesType === undefined) ??
    rules.find((rule) => rule.provider === undefined && rule.seriesType === undefined) ??
    null
  );
}

export function comparePolicyScopes(
  a: { provider?: string; seriesType?: string },
  b: { provider?: string; seriesType?: string },
) {
  const weight = (item: { provider?: string; seriesType?: string }) => {
    const scope = inferTimeSeriesPolicyScope(item.provider, item.seriesType);
    switch (scope) {
      case "global":
        return 0;
      case "provider":
        return 1;
      case "series":
        return 2;
      case "provider_series":
        return 3;
    }
  };

  return (
    weight(a) - weight(b) ||
    (a.provider ?? "").localeCompare(b.provider ?? "") ||
    (a.seriesType ?? "").localeCompare(b.seriesType ?? "")
  );
}

export function getBucketStart(recordedAt: number, bucketMs: number) {
  return Math.floor(recordedAt / bucketMs) * bucketMs;
}

export function getBucketEnd(bucketStart: number, bucketMs: number) {
  return bucketStart + bucketMs - 1;
}
