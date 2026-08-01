import type {
  SdkDeviceMetadata,
  SdkIngestionCategoryCounts,
  SdkIngestionMode,
  SdkIngestionRejection,
  SdkIngestionRejectionCode,
  SdkPushDataPoint,
  SdkPushEvent,
  SdkPushSummary,
  SdkSourceMetadata,
} from "../client/types";
import { SERIES_TYPES } from "../client/types";

export interface ParsedSdkPayloadV2 {
  providerUserId?: string;
  providerUsername?: string;
  syncTimestamp?: number;
  device?: SdkDeviceMetadata;
  sourceMetadata?: SdkSourceMetadata;
  events: SdkPushEvent[];
  dataPoints: SdkPushDataPoint[];
  summaries: SdkPushSummary[];
}

export interface SdkPayloadValidationResult {
  status: "accepted" | "partially_accepted" | "rejected";
  mode: SdkIngestionMode;
  canPersist: boolean;
  payload: ParsedSdkPayloadV2;
  counts: {
    received: number;
    accepted: number;
    rejected: number;
  };
  categories: {
    events: SdkIngestionCategoryCounts;
    dataPoints: SdkIngestionCategoryCounts;
    summaries: SdkIngestionCategoryCounts;
  };
  rejections: SdkIngestionRejection[];
  rejectionCountTruncated: number;
}

const MAX_EVENTS_PER_REQUEST = 500;
const MAX_DATA_POINTS_PER_REQUEST = 10_000;
const MAX_SUMMARIES_PER_REQUEST = 1_000;
const MAX_REJECTION_SAMPLES = 50;

const SERIES_TYPE_ALIASES = {
  hrv_rmssd: "heart_rate_variability_rmssd",
  POWER: "power",
  power: "power",
  SPEED: "speed",
  speed: "speed",
  CYCLING_PEDALING_CADENCE: "cadence",
  cycling_pedaling_cadence: "cadence",
  TOTAL_CALORIES_BURNED: "total_calories",
  total_calories_burned: "total_calories",
} as const;

const validSeriesTypes = new Set(Object.keys(SERIES_TYPES));

const sourceMetadataFields = {
  deviceModel: "string",
  softwareVersion: "string",
  source: "string",
  deviceType: "string",
  originalSourceName: "string",
  appId: "string",
  app_id: "string",
  bundleIdentifier: "string",
  bundle_identifier: "string",
} as const;

const deviceMetadataFields = {
  model: "string",
  softwareVersion: "string",
  source: "string",
  deviceType: "string",
  originalSourceName: "string",
  appId: "string",
  app_id: "string",
  bundleIdentifier: "string",
  bundle_identifier: "string",
} as const;

const eventFields = {
  ...sourceMetadataFields,
  category: "string",
  type: "string",
  sourceName: "string",
  durationSeconds: "number",
  startDatetime: "number",
  endDatetime: "number",
  externalId: "string",
  heartRateMin: "number",
  heartRateMax: "number",
  heartRateAvg: "number",
  energyBurned: "number",
  distance: "number",
  stepsCount: "number",
  maxSpeed: "number",
  maxWatts: "number",
  movingTimeSeconds: "number",
  totalElevationGain: "number",
  averageSpeed: "number",
  averageWatts: "number",
  elevHigh: "number",
  elevLow: "number",
  sleepTotalDurationMinutes: "number",
  sleepTimeInBedMinutes: "number",
  sleepEfficiencyScore: "number",
  sleepDeepMinutes: "number",
  sleepRemMinutes: "number",
  sleepLightMinutes: "number",
  sleepAwakeMinutes: "number",
  isNap: "boolean",
  sleepStages: "array",
} as const;

const dataPointFields = {
  ...sourceMetadataFields,
  seriesType: "string",
  recordedAt: "number",
  value: "number",
  externalId: "string",
} as const;

const summaryFields = {
  source: "string",
  originalSourceName: "string",
  appId: "string",
  app_id: "string",
  bundleIdentifier: "string",
  bundle_identifier: "string",
  date: "string",
  category: "string",
  totalSteps: "number",
  totalCalories: "number",
  activeCalories: "number",
  activeMinutes: "number",
  totalDistance: "number",
  floorsClimbed: "number",
  avgHeartRate: "number",
  maxHeartRate: "number",
  minHeartRate: "number",
  sleepDurationMinutes: "number",
  sleepEfficiency: "number",
  deepSleepMinutes: "number",
  remSleepMinutes: "number",
  lightSleepMinutes: "number",
  awakeDuringMinutes: "number",
  timeInBedMinutes: "number",
  hrvAvg: "number",
  hrvRmssd: "number",
  restingHeartRate: "number",
  recoveryScore: "number",
  weight: "number",
  bodyFatPercentage: "number",
  bodyMassIndex: "number",
  leanBodyMass: "number",
  bodyTemperature: "number",
  avgStressLevel: "number",
  bodyBattery: "number",
  spo2Avg: "number",
} as const;

type FieldKind = "array" | "boolean" | "number" | "string";

interface ValidationIssue {
  code: SdkIngestionRejectionCode;
  path?: string;
  message: string;
}

export function normalizeSdkSeriesType(seriesType: string): string | null {
  const normalized =
    SERIES_TYPE_ALIASES[seriesType as keyof typeof SERIES_TYPE_ALIASES] ?? seriesType;
  return validSeriesTypes.has(normalized) ? normalized : null;
}

export function parseSdkPayloadV2(
  input: unknown,
  mode: SdkIngestionMode = "partial",
): SdkPayloadValidationResult {
  const accepted: ParsedSdkPayloadV2 = {
    events: [],
    dataPoints: [],
    summaries: [],
  };
  const allRejections: SdkIngestionRejection[] = [];
  const categoryCounts = {
    events: emptyCounts(),
    dataPoints: emptyCounts(),
    summaries: emptyCounts(),
  };

  if (!isRecord(input)) {
    allRejections.push({
      category: "payload",
      index: -1,
      code: "invalid_envelope",
      message: "Payload must be an object.",
    });
    return buildResult(mode, accepted, categoryCounts, allRejections, true);
  }

  const allowedEnvelopeFields = new Set([
    "providerUserId",
    "providerUsername",
    "syncTimestamp",
    "device",
    "sourceMetadata",
    "events",
    "dataPoints",
    "summaries",
    "dailySummaries",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedEnvelopeFields.has(key)) {
      allRejections.push({
        category: "payload",
        index: -1,
        code: "unknown_field",
        path: safeFieldPath(key),
        message: "Payload contains an unsupported field.",
      });
    }
  }

  copyOptionalScalar(input, accepted, "providerUserId", "string", allRejections);
  copyOptionalScalar(input, accepted, "providerUsername", "string", allRejections);
  copyOptionalScalar(input, accepted, "syncTimestamp", "number", allRejections);
  copyOptionalObject(input, accepted, "device", deviceMetadataFields, allRejections);
  copyOptionalObject(input, accepted, "sourceMetadata", sourceMetadataFields, allRejections);

  const events = readArray(input, "events", allRejections);
  const dataPoints = readArray(input, "dataPoints", allRejections);
  const summaries = readArray(input, "summaries", allRejections);
  const dailySummaries = readArray(input, "dailySummaries", allRejections);

  categoryCounts.events.received = events.length;
  categoryCounts.dataPoints.received = dataPoints.length;
  categoryCounts.summaries.received = summaries.length + dailySummaries.length;

  const limitExceeded = [
    addLimitRejection(allRejections, "events", events.length, MAX_EVENTS_PER_REQUEST),
    addLimitRejection(allRejections, "dataPoints", dataPoints.length, MAX_DATA_POINTS_PER_REQUEST),
    addLimitRejection(
      allRejections,
      "summaries",
      summaries.length + dailySummaries.length,
      MAX_SUMMARIES_PER_REQUEST,
    ),
  ].some(Boolean);

  const envelopeRejected = allRejections.some((item) => item.category === "payload");
  if (limitExceeded || envelopeRejected) {
    categoryCounts.events.rejected = categoryCounts.events.received;
    categoryCounts.dataPoints.rejected = categoryCounts.dataPoints.received;
    categoryCounts.summaries.rejected = categoryCounts.summaries.received;
    return buildResult(mode, accepted, categoryCounts, allRejections, true);
  }

  parseRows(events, "events", eventFields, ["category", "startDatetime"], allRejections, (row) => {
    const category = row.category;
    if (category !== "workout" && category !== "sleep") {
      return issue("invalid_value", "category", "Event category must be workout or sleep.");
    }
    const sleepStagesIssue = validateSleepStages(row.sleepStages);
    if (sleepStagesIssue) return sleepStagesIssue;
    if (
      typeof row.endDatetime === "number" &&
      typeof row.startDatetime === "number" &&
      row.endDatetime < row.startDatetime
    ) {
      return issue(
        "invalid_value",
        "endDatetime",
        "Event endDatetime must not precede startDatetime.",
      );
    }
    accepted.events.push(row as unknown as SdkPushEvent);
    return null;
  });

  parseRows(
    dataPoints,
    "dataPoints",
    dataPointFields,
    ["seriesType", "recordedAt", "value"],
    allRejections,
    (row) => {
      const normalized = normalizeSdkSeriesType(row.seriesType as string);
      if (!normalized) {
        return issue(
          "unsupported_series_type",
          "seriesType",
          "Data point seriesType is not supported.",
        );
      }
      accepted.dataPoints.push({ ...(row as unknown as SdkPushDataPoint), seriesType: normalized });
      return null;
    },
  );

  const acceptSummary = (row: Record<string, unknown>): ValidationIssue | null => {
    if (!isIsoDate(row.date as string)) {
      return issue("invalid_value", "date", "Summary date must use YYYY-MM-DD.");
    }
    if ((row.category as string).trim().length === 0) {
      return issue("invalid_value", "category", "Summary category must not be empty.");
    }
    accepted.summaries.push(row as unknown as SdkPushSummary);
    return null;
  };
  parseRows(
    summaries,
    "summaries",
    summaryFields,
    ["date", "category"],
    allRejections,
    acceptSummary,
  );
  parseRows(
    dailySummaries,
    "dailySummaries",
    summaryFields,
    ["date", "category"],
    allRejections,
    acceptSummary,
  );

  categoryCounts.events.accepted = accepted.events.length;
  categoryCounts.dataPoints.accepted = accepted.dataPoints.length;
  categoryCounts.summaries.accepted = accepted.summaries.length;
  categoryCounts.events.rejected = categoryCounts.events.received - categoryCounts.events.accepted;
  categoryCounts.dataPoints.rejected =
    categoryCounts.dataPoints.received - categoryCounts.dataPoints.accepted;
  categoryCounts.summaries.rejected =
    categoryCounts.summaries.received - categoryCounts.summaries.accepted;

  return buildResult(mode, accepted, categoryCounts, allRejections, false);
}

function parseRows(
  rows: unknown[],
  category: "events" | "dataPoints" | "summaries" | "dailySummaries",
  fields: Record<string, FieldKind>,
  required: string[],
  rejections: SdkIngestionRejection[],
  accept: (row: Record<string, unknown>) => ValidationIssue | null,
) {
  rows.forEach((row, index) => {
    const baseIssue = validateRecord(row, fields, required);
    const rowIssue = baseIssue ?? accept(row as Record<string, unknown>);
    if (rowIssue) {
      rejections.push({ category, index, ...rowIssue });
    }
  });
}

function validateRecord(
  input: unknown,
  fields: Record<string, FieldKind>,
  required: string[],
): ValidationIssue | null {
  if (!isRecord(input)) {
    return issue("invalid_type", undefined, "Row must be an object.");
  }
  for (const field of required) {
    if (input[field] === undefined) {
      return issue("missing_field", field, `Required field "${field}" is missing.`);
    }
  }
  for (const [field, value] of Object.entries(input)) {
    const expected = fields[field];
    if (!expected) {
      return issue("unknown_field", safeFieldPath(field), "Row contains an unsupported field.");
    }
    if (!matchesKind(value, expected)) {
      return issue("invalid_type", field, `Field "${field}" has an invalid type.`);
    }
  }
  return null;
}

function validateSleepStages(value: unknown): ValidationIssue | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    return issue("invalid_type", "sleepStages", "Field " + '"sleepStages" has an invalid type.');
  }
  for (let index = 0; index < value.length; index += 1) {
    const stage = value[index];
    const stageIssue = validateRecord(
      stage,
      { stage: "string", startTime: "number", endTime: "number" },
      ["stage", "startTime", "endTime"],
    );
    if (stageIssue) {
      return issue(
        stageIssue.code,
        `sleepStages.${index}.${stageIssue.path ?? ""}`,
        stageIssue.message,
      );
    }
  }
  return null;
}

function copyOptionalScalar(
  input: Record<string, unknown>,
  output: ParsedSdkPayloadV2,
  field: string,
  kind: "number" | "string",
  rejections: SdkIngestionRejection[],
) {
  const value = input[field];
  if (value === undefined) return;
  if (!matchesKind(value, kind)) {
    rejections.push({
      category: "payload",
      index: -1,
      code: "invalid_type",
      path: field,
      message: `Payload field "${field}" has an invalid type.`,
    });
    return;
  }
  (output as unknown as Record<string, unknown>)[field] = value;
}

function copyOptionalObject(
  input: Record<string, unknown>,
  output: ParsedSdkPayloadV2,
  field: string,
  fields: Record<string, FieldKind>,
  rejections: SdkIngestionRejection[],
) {
  const value = input[field];
  if (value === undefined) return;
  const validationIssue = validateRecord(value, fields, []);
  if (validationIssue) {
    rejections.push({
      category: "payload",
      index: -1,
      ...validationIssue,
      path: validationIssue.path ? `${field}.${validationIssue.path}` : field,
    });
    return;
  }
  (output as unknown as Record<string, unknown>)[field] = value;
}

function readArray(
  input: Record<string, unknown>,
  field: "events" | "dataPoints" | "summaries" | "dailySummaries",
  rejections: SdkIngestionRejection[],
): unknown[] {
  const value = input[field];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  rejections.push({
    category: "payload",
    index: -1,
    code: "invalid_type",
    path: field,
    message: `Payload field "${field}" must be an array.`,
  });
  return [];
}

function addLimitRejection(
  rejections: SdkIngestionRejection[],
  category: "events" | "dataPoints" | "summaries",
  count: number,
  limit: number,
): boolean {
  if (count <= limit) return false;
  rejections.push({
    category: "payload",
    index: -1,
    code: "limit_exceeded",
    path: category,
    message: `Payload exceeds the ${category} row limit of ${limit}.`,
  });
  return true;
}

function buildResult(
  mode: SdkIngestionMode,
  payload: ParsedSdkPayloadV2,
  categories: SdkPayloadValidationResult["categories"],
  allRejections: SdkIngestionRejection[],
  envelopeRejected: boolean,
): SdkPayloadValidationResult {
  const received =
    categories.events.received + categories.dataPoints.received + categories.summaries.received;
  const accepted =
    categories.events.accepted + categories.dataPoints.accepted + categories.summaries.accepted;
  const rejected = received - accepted;
  const canPersist = !envelopeRejected && (mode === "partial" || rejected === 0);
  const status =
    envelopeRejected || (mode === "strict" && rejected > 0) || (accepted === 0 && rejected > 0)
      ? "rejected"
      : rejected > 0
        ? "partially_accepted"
        : "accepted";
  return {
    status,
    mode,
    canPersist,
    payload,
    counts: { received, accepted, rejected },
    categories,
    rejections: allRejections.slice(0, MAX_REJECTION_SAMPLES),
    rejectionCountTruncated: Math.max(0, allRejections.length - MAX_REJECTION_SAMPLES),
  };
}

function emptyCounts(): SdkIngestionCategoryCounts {
  return { received: 0, accepted: 0, rejected: 0, stored: 0 };
}

function issue(
  code: SdkIngestionRejectionCode,
  path: string | undefined,
  message: string,
): ValidationIssue {
  return { code, path, message };
}

function matchesKind(value: unknown, kind: FieldKind): boolean {
  if (kind === "array") return Array.isArray(value);
  if (kind === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === kind;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFieldPath(field: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field) ? field : undefined;
}
