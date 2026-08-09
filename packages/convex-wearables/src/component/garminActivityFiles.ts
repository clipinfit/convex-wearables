"use node";

import { v } from "convex/values";
import FitParser from "fit-file-parser";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const DEFAULT_ALLOWED_HOSTS = ["apis.garmin.com", "connectapi.garmin.com"];
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_SEGMENTS = 500;
const MAX_ZONES = 20;
const MAX_SAMPLES = 100_000;
const MAX_ATTEMPTS = 8;

type Segment = {
  kind: "lap" | "split" | "length" | "set";
  index: number;
  startDatetime?: number;
  elapsedSeconds?: number;
  timerSeconds?: number;
  distanceMeters?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  averagePower?: number;
  maxPower?: number;
  averageCadence?: number;
  strokes?: number;
  exercise?: string;
  repetitions?: number;
  weight?: number;
  weightUnit?: string;
  setType?: string;
};

type Zone = {
  kind: "heart_rate" | "power";
  zone: number;
  lowerBound?: number;
  upperBound?: number;
  seconds: number;
};

type FitRow = Record<string, unknown>;
type ParsedFitInput = {
  laps?: FitRow[];
  splits?: FitRow[];
  lengths?: FitRow[];
  sets?: FitRow[];
  records?: FitRow[];
  time_in_zone?: FitRow[];
};

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function scalarLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const flat = value
    .flat(2)
    .find((entry) => typeof entry === "string" || typeof entry === "number");
  return flat === undefined ? undefined : String(flat);
}

export function normalizeFitMessages(parsed: ParsedFitInput): {
  segments: Segment[];
  zones: Zone[];
  samples: Array<{ seriesType: string; recordedAt: number; value: number }>;
} {
  const segments: Segment[] = [];
  const addSegments = (kind: Segment["kind"], rows: FitRow[] | undefined) => {
    for (const [index, row] of (rows ?? []).entries()) {
      if (segments.length >= MAX_SEGMENTS) break;
      segments.push({
        kind,
        index,
        startDatetime: timestamp(row.start_time ?? row.timestamp),
        elapsedSeconds: finite(row.total_elapsed_time ?? row.duration),
        timerSeconds: finite(row.total_timer_time),
        distanceMeters: finite(row.total_distance),
        averageHeartRate: finite(row.avg_heart_rate),
        maxHeartRate: finite(row.max_heart_rate),
        averageSpeed: finite(row.avg_speed),
        maxSpeed: finite(row.max_speed),
        averagePower: finite(row.avg_power),
        maxPower: finite(row.max_power),
        averageCadence: finite(row.avg_cadence ?? row.avg_swimming_cadence),
        strokes: finite(row.total_strokes),
        exercise: kind === "set" ? scalarLabel(row.category) : undefined,
        repetitions: kind === "set" ? finite(row.repetitions) : undefined,
        weight: kind === "set" ? finite(row.weight) : undefined,
        weightUnit: kind === "set" ? scalarLabel(row.weight_display_unit) : undefined,
        setType: kind === "set" ? scalarLabel(row.set_type) : undefined,
      });
    }
  };
  addSegments("lap", parsed.laps);
  addSegments("split", parsed.splits);
  addSegments("length", parsed.lengths);
  addSegments("set", parsed.sets);

  const zones: Zone[] = [];
  const timeInZone = parsed.time_in_zone?.[0];
  const addZones = (kind: Zone["kind"], durations: unknown, boundaries: unknown) => {
    const times = Array.isArray(durations) ? durations.flat(2) : [];
    const highs = Array.isArray(boundaries) ? boundaries.flat(2) : [];
    let lowerBound: number | undefined;
    for (let index = 0; index < times.length && zones.length < MAX_ZONES; index++) {
      const seconds = finite(times[index]);
      if (seconds === undefined) continue;
      const upperBound = finite(highs[index]);
      zones.push({ kind, zone: index, lowerBound, upperBound, seconds });
      lowerBound = upperBound;
    }
  };
  addZones("heart_rate", timeInZone?.time_in_hr_zone, timeInZone?.hr_zone_high_boundary);
  addZones("power", timeInZone?.time_in_power_zone, timeInZone?.power_zone_high_boundary);

  const sampleFields = {
    heart_rate: "heart_rate",
    enhanced_speed: "speed",
    speed: "speed",
    cadence: "cadence",
    power: "power",
    enhanced_altitude: "elevation",
    altitude: "elevation",
    position_lat: "latitude",
    position_long: "longitude",
    temperature: "air_temperature",
    vertical_oscillation: "vertical_oscillation",
    stance_time: "ground_contact_time",
    step_length: "step_length",
  } as const;
  const samples: Array<{ seriesType: string; recordedAt: number; value: number }> = [];
  for (const record of parsed.records ?? []) {
    if (samples.length >= MAX_SAMPLES) break;
    const recordedAt = timestamp(record.timestamp);
    if (recordedAt === undefined) continue;
    const emitted = new Set<string>();
    for (const [field, seriesType] of Object.entries(sampleFields)) {
      if (samples.length >= MAX_SAMPLES) break;
      if (emitted.has(seriesType)) continue;
      let value = finite(record[field]);
      if (value === undefined) continue;
      if (field === "vertical_oscillation" || field === "step_length") {
        value /= 10;
      }
      samples.push({ seriesType, recordedAt, value });
      emitted.add(seriesType);
    }
  }
  return { segments, zones, samples };
}

async function downloadFit(
  urlValue: string,
  accessToken: string,
  allowedHosts: string[],
  maxBytes: number,
) {
  const url = validateActivityFileUrl(urlValue, allowedHosts);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/octet-stream" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Garmin Activity File download failed (${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType &&
    !["application/octet-stream", "application/fit", "application/vnd.ant.fit"].includes(
      contentType,
    )
  ) {
    throw new Error("Garmin Activity File response has an unsupported content type");
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared)) assertWithinFitSizeLimit(declared, maxBytes);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertWithinFitSizeLimit(bytes.byteLength, maxBytes);
  return bytes;
}

export function validateActivityFileUrl(urlValue: string, allowedHosts: string[]): URL {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error("Garmin Activity File callback host is not allowed");
  }
  return url;
}

export function assertWithinFitSizeLimit(size: number, maxBytes: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new Error("FIT file exceeds size limit");
  }
}

export const processActivityFile = internalAction({
  args: {
    jobId: v.id("garminActivityFileJobs"),
    allowedHosts: v.optional(v.array(v.string())),
    maxBytes: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claimed = await ctx.runMutation(internal.garminActivityFileJobs.claim, {
      jobId: args.jobId,
    });
    if (!claimed) return null;
    const job = await ctx.runQuery(internal.garminActivityFileJobs.get, { jobId: args.jobId });
    if (!job?.callbackUrl) return null;

    let downloaded = false;
    try {
      const event = await ctx.runQuery(internal.events.getByExternalId, {
        externalId: job.eventExternalId,
      });
      const connection = await ctx.runQuery(internal.connections.getById, {
        connectionId: job.connectionId,
      });
      if (!event || !connection?.accessToken) {
        throw new Error("Workout summary or active Garmin connection is not available yet");
      }

      const bytes = await downloadFit(
        job.callbackUrl,
        connection.accessToken,
        (args.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((host) => host.toLowerCase()),
        Math.min(Math.max(args.maxBytes ?? DEFAULT_MAX_BYTES, 1), DEFAULT_MAX_BYTES),
      );
      downloaded = true;
      const parsed = await new FitParser({
        mode: "list",
        force: false,
        speedUnit: "m/s",
        lengthUnit: "m",
      }).parseAsync(Buffer.from(bytes));
      const enrichment = normalizeFitMessages(parsed as unknown as ParsedFitInput);

      await ctx.runMutation(internal.workoutEnrichment.replaceWorkoutEnrichment, {
        eventId: event._id,
        userId: event.userId,
        provider: "garmin",
        segments: enrichment.segments,
        zones: enrichment.zones,
      });
      const existingDetailSeries = new Set(
        await ctx.runQuery(internal.dataPoints.getExistingDetailSeries, {
          dataSourceId: job.dataSourceId,
          startDate: event.startDatetime,
          endDate: event.endDatetime ?? event.startDatetime + (event.durationSeconds ?? 0) * 1000,
        }),
      );
      const points = enrichment.samples
        .filter((point) => !existingDetailSeries.has(point.seriesType))
        .map((point, index) => ({
          ...point,
          externalId: `garmin-${job.activityId}:fit:${index}:${point.seriesType}`,
        }));
      for (let index = 0; index < points.length; index += 500) {
        const batch = points.slice(index, index + 500);
        const byType = Map.groupBy(batch, (point) => point.seriesType);
        for (const [seriesType, seriesPoints] of byType) {
          await ctx.runMutation(internal.dataPoints.storeBatch, {
            dataSourceId: job.dataSourceId,
            seriesType,
            points: seriesPoints.map(({ recordedAt, value, externalId }) => ({
              recordedAt,
              value,
              externalId,
            })),
          });
        }
      }
      await ctx.runMutation(internal.garminActivityFileJobs.finish, {
        jobId: args.jobId,
        status: "completed",
        scrubCallbackUrl: true,
      });
    } catch (error) {
      const current = await ctx.runQuery(internal.garminActivityFileJobs.get, {
        jobId: args.jobId,
      });
      const message = error instanceof Error ? error.message : "Unknown Activity File error";
      const canRetry =
        !downloaded && current && current.attempts < MAX_ATTEMPTS && current.expiresAt > Date.now();
      await ctx.runMutation(internal.garminActivityFileJobs.finish, {
        jobId: args.jobId,
        status: "failed",
        error: message,
        scrubCallbackUrl: !canRetry,
      });
      if (canRetry) {
        await ctx.scheduler.runAfter(
          Math.min(30_000 * 2 ** (current.attempts - 1), 15 * 60 * 1000),
          internal.garminActivityFiles.processActivityFile,
          args,
        );
      }
    }
    return null;
  },
});
