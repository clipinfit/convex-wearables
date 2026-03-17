import { makeAuthenticatedRequest } from "./oauth";
import type {
  NormalizedDailySummary,
  NormalizedDataPoint,
  NormalizedEvent,
  OAuthProviderConfig,
  ProviderAdapter,
  ProviderCredentials,
  ProviderUserInfo,
} from "./types";

const API_BASE = "https://cloudapi.suunto.com";
const WORKOUTS_ENDPOINT = "/v3/workouts/";
const SLEEP_ENDPOINT = "/247samples/sleep";
const RECOVERY_ENDPOINT = "/247samples/recovery";
const ACTIVITY_ENDPOINT = "/247samples/activity";
const DAILY_STATS_ENDPOINT = "/247/daily-activity-statistics";
const SLEEP_CHUNK_MS = 20 * 24 * 60 * 60 * 1000;
const DAILY_STATS_CHUNK_MS = 14 * 24 * 60 * 60 * 1000;
const SUBSCRIPTION_HEADER = "Ocp-Apim-Subscription-Key";
const ENERGY_CONVERSION = 4184; // joules → kcal

const SUUNTO_ACTIVITY_TYPE_MAP: Record<number, string> = {
  0: "walking",
  1: "running",
  2: "cycling",
  3: "cross_country_skiing",
  4: "other",
  5: "other",
  6: "other",
  7: "other",
  8: "other",
  9: "other",
  10: "mountain_biking",
  11: "hiking",
  12: "inline_skating",
  13: "alpine_skiing",
  14: "paddling",
  15: "rowing",
  16: "golf",
  17: "fitness_equipment",
  18: "other",
  19: "other",
  20: "fitness_equipment",
  21: "swimming",
  22: "trail_running",
  23: "strength_training",
  24: "walking",
  25: "horseback_riding",
  26: "motorcycling",
  27: "skateboarding",
  28: "other",
  29: "rock_climbing",
  30: "snowboarding",
  31: "backcountry_skiing",
  32: "aerobics",
  33: "soccer",
  34: "tennis",
  35: "basketball",
  36: "badminton",
  37: "baseball",
  38: "volleyball",
  39: "american_football",
  40: "table_tennis",
  41: "other",
  42: "squash",
  43: "floorball",
  44: "handball",
  45: "baseball",
  46: "other",
  47: "other",
  48: "rugby",
  49: "ice_skating",
  50: "hockey",
  51: "yoga",
  52: "indoor_cycling",
  53: "treadmill",
  54: "strength_training",
  55: "elliptical",
  56: "cross_country_skiing",
  57: "rowing_machine",
  58: "stretching",
  59: "running",
  60: "orienteering",
  61: "stand_up_paddleboarding",
  62: "martial_arts",
  63: "strength_training",
  64: "dance",
  65: "snowshoeing",
  66: "other",
  67: "soccer",
  68: "multisport",
  69: "aerobics",
  70: "hiking",
  71: "sailing",
  72: "kayaking",
  73: "strength_training",
  74: "triathlon",
  75: "padel",
  76: "aerobics",
  77: "boxing",
  78: "diving",
  79: "diving",
  80: "multisport",
  81: "fitness_equipment",
  82: "canoeing",
  83: "mountaineering",
  84: "alpine_skiing",
  85: "open_water_swimming",
  86: "windsurfing",
  87: "kitesurfing",
  88: "other",
  90: "diving",
  91: "surfing",
  92: "multisport",
  93: "multisport",
  94: "multisport",
  95: "running",
  96: "other",
  97: "other",
  98: "transition",
  99: "cycling",
  100: "swimming",
  101: "diving",
  102: "cardio_training",
  103: "running",
  104: "strength_training",
  105: "e_biking",
  106: "e_biking",
  107: "backcountry_skiing",
  108: "other",
  109: "cycling",
  110: "snowboarding",
  111: "multisport",
  112: "stretching",
  113: "hockey",
  114: "cyclocross",
  115: "trail_running",
  116: "mountaineering",
  117: "cross_country_skiing",
  118: "cross_country_skiing",
  119: "other",
  120: "pilates",
  121: "yoga",
};

function toDateString(value: number | string): string | undefined {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString().split("T")[0];
}

function parseTimestamp(value: number | string | undefined | null): number | undefined {
  if (typeof value === "number") return value;
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function buildHeaders(subscriptionKey?: string): Record<string, string> | undefined {
  return subscriptionKey ? { [SUBSCRIPTION_HEADER]: subscriptionKey } : undefined;
}

function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
  try {
    const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

function mapActivityType(activityId?: number): string {
  if (activityId == null) return "other";
  return SUUNTO_ACTIVITY_TYPE_MAP[activityId] ?? "other";
}

async function paginatedWorkouts(
  accessToken: string,
  startDate: number,
  endDate: number,
  credentials?: ProviderCredentials,
): Promise<any[]> {
  const headers = buildHeaders(credentials?.subscriptionKey);
  const perPage = 100;
  const items: any[] = [];
  let offset = 0;
  while (true) {
    const response = await makeAuthenticatedRequest<any>(API_BASE, WORKOUTS_ENDPOINT, accessToken, {
      params: {
        since: Math.floor(startDate / 1000),
        limit: perPage,
        offset,
      },
      headers,
    });

    const payload = Array.isArray(response?.payload) ? response.payload : [];
    if (!payload.length) break;
    items.push(
      ...payload.filter((workout: any) => {
        const start = parseTimestamp(workout?.startTime);
        return start !== undefined && start >= startDate && start <= endDate;
      }),
    );
    if (payload.length < perPage) break;
    offset += payload.length;
  }
  return items;
}

function normalizeWorkout(raw: any): NormalizedEvent {
  const start = typeof raw.startTime === "number" ? raw.startTime : undefined;
  const end = typeof raw.stopTime === "number" ? raw.stopTime : undefined;
  const duration = typeof raw.totalTime === "number" ? raw.totalTime : undefined;
  const hrData = raw.hrdata ?? {};

  return {
    category: "workout",
    type: mapActivityType(raw.activityId),
    sourceName: raw.gear?.displayName ?? raw.gear?.name ?? "Suunto",
    deviceModel: raw.gear?.displayName ?? raw.gear?.name,
    softwareVersion: raw.gear?.swVersion,
    source: "suunto",
    originalSourceName: raw.gear?.name,
    durationSeconds: duration,
    startDatetime: start ?? Date.now(),
    endDatetime: end,
    externalId: raw.workoutId != null ? `suunto-workout-${raw.workoutId}` : undefined,
    heartRateMin: hrData?.min,
    heartRateMax: hrData?.hrmax ?? hrData?.max,
    heartRateAvg: hrData?.avg ?? undefined,
    energyBurned: raw.energyConsumption,
    distance: raw.totalDistance,
    stepsCount: raw.stepCount,
    maxSpeed: typeof raw.maxSpeed === "number" ? raw.maxSpeed * 3.6 : undefined,
    averageSpeed: typeof raw.avgSpeed === "number" ? raw.avgSpeed * 3.6 : undefined,
    maxWatts: raw.maxPower,
    averageWatts: raw.avgPower,
    totalElevationGain: raw.totalAscent,
    elevHigh: raw.maxAltitude,
    elevLow: raw.minAltitude,
    movingTimeSeconds: duration,
  };
}

function normalizeSleep(raw: any): NormalizedEvent | null {
  const entry = raw.entryData ?? {};
  const startTime = parseTimestamp(entry.BedtimeStart);
  const endTime = parseTimestamp(entry.BedtimeEnd);
  const durationSeconds = Number(entry.Duration ?? 0);
  if (!startTime || !endTime) return null;

  const deepSeconds = Number(entry.DeepSleepDuration ?? 0);
  const lightSeconds = Number(entry.LightSleepDuration ?? 0);
  const remSeconds = Number(entry.REMSleepDuration ?? 0);
  const awakeSeconds = Math.max(0, durationSeconds - deepSeconds - lightSeconds - remSeconds);
  const totalSleepMinutes = Math.floor((deepSeconds + lightSeconds + remSeconds) / 60);
  const timeInBedMinutes = Math.floor(durationSeconds / 60);

  return {
    category: "sleep",
    type: "sleep_session",
    sourceName: "Suunto",
    source: "suunto",
    durationSeconds,
    startDatetime: startTime,
    endDatetime: endTime,
    externalId: entry.SleepId != null ? `suunto-sleep-${entry.SleepId}` : undefined,
    sleepTotalDurationMinutes: totalSleepMinutes,
    sleepTimeInBedMinutes: timeInBedMinutes,
    sleepDeepMinutes: Math.floor(deepSeconds / 60),
    sleepLightMinutes: Math.floor(lightSeconds / 60),
    sleepRemMinutes: Math.floor(remSeconds / 60),
    sleepAwakeMinutes: Math.floor(awakeSeconds / 60),
    sleepEfficiencyScore: entry.SleepQualityScore,
    isNap: Boolean(entry.IsNap),
  };
}

async function fetchSleepEvents(
  accessToken: string,
  startDate: number,
  endDate: number,
  credentials?: ProviderCredentials,
): Promise<NormalizedEvent[]> {
  const headers = buildHeaders(credentials?.subscriptionKey);
  const events: NormalizedEvent[] = [];
  let cursor = startDate;

  while (cursor < endDate) {
    const chunkEnd = Math.min(cursor + SLEEP_CHUNK_MS, endDate);
    const response = await makeAuthenticatedRequest<any>(API_BASE, SLEEP_ENDPOINT, accessToken, {
      params: {
        from: cursor,
        to: chunkEnd,
      },
      headers,
    });

    const entries = Array.isArray(response) ? response : [];
    for (const entry of entries) {
      const normalized = normalizeSleep(entry);
      if (normalized) events.push(normalized);
    }

    if (chunkEnd === endDate) break;
    cursor = chunkEnd;
  }

  return events;
}

function normalizeRecoverySample(raw: any): NormalizedDataPoint[] {
  const timestamp = parseTimestamp(raw.timestamp);
  if (!timestamp) return [];
  const entry = raw.entryData ?? {};
  const value = Number(entry.Balance ?? entry.balance ?? null);
  if (!Number.isFinite(value)) return [];
  return [
    {
      seriesType: "recovery_score",
      recordedAt: timestamp,
      value: value * 100,
      source: "suunto",
    },
  ];
}

function normalizeActivitySamples(raw: any): NormalizedDataPoint[] {
  const timestamp = parseTimestamp(raw.timestamp);
  if (!timestamp) return [];
  const entry = raw.entryData ?? {};
  const points: NormalizedDataPoint[] = [];

  if (Number.isFinite(entry.HR)) {
    points.push({
      seriesType: "heart_rate",
      recordedAt: timestamp,
      value: Number(entry.HR),
      source: "suunto",
    });
  }
  if (Number.isFinite(entry.StepCount)) {
    points.push({
      seriesType: "steps",
      recordedAt: timestamp,
      value: Number(entry.StepCount),
      source: "suunto",
    });
  }
  if (Number.isFinite(entry.SpO2)) {
    const spo2 = Number(entry.SpO2);
    points.push({
      seriesType: "oxygen_saturation",
      recordedAt: timestamp,
      value: spo2 <= 1 ? spo2 * 100 : spo2,
      source: "suunto",
    });
  }
  if (Number.isFinite(entry.EnergyConsumption)) {
    points.push({
      seriesType: "energy",
      recordedAt: timestamp,
      value: Number(entry.EnergyConsumption) / ENERGY_CONVERSION,
      source: "suunto",
    });
  }
  if (Number.isFinite(entry.HRV)) {
    points.push({
      seriesType: "heart_rate_variability_rmssd",
      recordedAt: timestamp,
      value: Number(entry.HRV),
      source: "suunto",
    });
  }

  return points;
}

function normalizeDailyStatSample(
  stat: any,
): { date: string; type: string; recordedAt: number; value: number }[] {
  const type = (stat.Name ?? stat.type ?? "").toLowerCase();
  const samples = [] as { date: string; type: string; recordedAt: number; value: number }[];
  const sources = Array.isArray(stat.Sources) ? stat.Sources : [];
  for (const source of sources) {
    const entries = Array.isArray(source.Samples) ? source.Samples : [];
    for (const sample of entries) {
      const timestamp = parseTimestamp(sample.TimeISO8601);
      if (!timestamp || sample.Value == null) continue;
      let value = Number(sample.Value);
      if (!Number.isFinite(value)) continue;
      if (type === "energyconsumption") {
        value = value / ENERGY_CONVERSION;
      }
      const date = toDateString(timestamp);
      if (!date) continue;
      samples.push({ date, type, recordedAt: timestamp, value });
    }
  }
  return samples;
}

async function fetchDailyStats(
  accessToken: string,
  startDate: number,
  endDate: number,
  credentials?: ProviderCredentials,
): Promise<NormalizedDataPoint[]> {
  const headers = buildHeaders(credentials?.subscriptionKey);
  const points: NormalizedDataPoint[] = [];
  let cursor = startDate;

  while (cursor < endDate) {
    const chunkEnd = Math.min(cursor + DAILY_STATS_CHUNK_MS, endDate);
    const response = await makeAuthenticatedRequest<any>(
      API_BASE,
      DAILY_STATS_ENDPOINT,
      accessToken,
      {
        params: {
          startdate: new Date(cursor).toISOString().split(".")[0],
          enddate: new Date(chunkEnd).toISOString().split(".")[0],
        },
        headers,
      },
    );
    const stats = Array.isArray(response) ? response : [];

    for (const stat of stats) {
      const normalized = normalizeDailyStatSample(stat);
      for (const sample of normalized) {
        const seriesType =
          sample.type === "stepcount"
            ? "steps"
            : sample.type === "energyconsumption"
              ? "energy"
              : undefined;
        if (!seriesType) continue;
        points.push({
          seriesType,
          recordedAt: sample.recordedAt,
          value: sample.value,
          source: "suunto",
        });
      }
    }

    if (chunkEnd === endDate) break;
    cursor = chunkEnd;
  }

  return points;
}

async function fetchRecurrencePoints(
  accessToken: string,
  startDate: number,
  endDate: number,
  endpoint: string,
  credentials?: ProviderCredentials,
): Promise<any[]> {
  const headers = buildHeaders(credentials?.subscriptionKey);
  const results: any[] = [];
  let cursor = startDate;

  while (cursor < endDate) {
    const chunkEnd = Math.min(cursor + SLEEP_CHUNK_MS, endDate);
    const response = await makeAuthenticatedRequest<any>(API_BASE, endpoint, accessToken, {
      params: { from: cursor, to: chunkEnd },
      headers,
    });
    if (Array.isArray(response)) results.push(...response);
    if (chunkEnd === endDate) break;
    cursor = chunkEnd;
  }

  return results;
}

async function fetchSuuntoRecovery(
  accessToken: string,
  startDate: number,
  endDate: number,
  credentials?: ProviderCredentials,
): Promise<NormalizedDataPoint[]> {
  const raws = await fetchRecurrencePoints(
    accessToken,
    startDate,
    endDate,
    RECOVERY_ENDPOINT,
    credentials,
  );
  return raws.flatMap(normalizeRecoverySample);
}

async function fetchSuuntoActivity(
  accessToken: string,
  startDate: number,
  endDate: number,
  credentials?: ProviderCredentials,
): Promise<NormalizedDataPoint[]> {
  const raws = await fetchRecurrencePoints(
    accessToken,
    startDate,
    endDate,
    ACTIVITY_ENDPOINT,
    credentials,
  );
  return raws.flatMap(normalizeActivitySamples);
}

async function aggregateDailySummaries(
  accessToken: string,
  startDate: number,
  endDate: number,
  credentials?: ProviderCredentials,
): Promise<NormalizedDailySummary[]> {
  const dataPoints = await fetchDailyStats(accessToken, startDate, endDate, credentials);
  const summaryMap: Record<string, NormalizedDailySummary> = {};

  for (const point of dataPoints) {
    const dateKey = new Date(point.recordedAt).toISOString().split("T")[0];
    const bucket = summaryMap[dateKey] ?? { date: dateKey, category: "activity" };
    if (point.seriesType === "steps") {
      bucket.totalSteps = (bucket.totalSteps ?? 0) + point.value;
    }
    if (point.seriesType === "energy") {
      bucket.totalCalories = (bucket.totalCalories ?? 0) + point.value;
    }
    summaryMap[dateKey] = bucket;
  }

  return Object.values(summaryMap);
}

export function suuntoOAuthConfig(credentials: ProviderCredentials): OAuthProviderConfig {
  return {
    endpoints: {
      authorizeUrl: "https://cloudapi-oauth.suunto.com/oauth/authorize",
      tokenUrl: "https://cloudapi-oauth.suunto.com/oauth/token",
      apiBaseUrl: API_BASE,
    },
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    defaultScope: "",
    usePkce: false,
    authMethod: "body",
    defaultHeaders: buildHeaders(credentials.subscriptionKey),
  };
}

export async function getSuuntoUserInfo(
  accessToken: string,
  _tokenResponse?: unknown,
  _appUserId?: string,
  _credentials?: ProviderCredentials,
): Promise<ProviderUserInfo> {
  const payload = decodeJwt(accessToken);
  return {
    providerUserId: payload?.sub ? String(payload.sub) : null,
    username: typeof payload?.user === "string" ? payload.user : null,
  };
}

export const suuntoProvider: ProviderAdapter = {
  name: "suunto",
  oauthConfig: suuntoOAuthConfig,
  getUserInfo: getSuuntoUserInfo,
  fetchEvents: async (accessToken, startDate, endDate, credentials) => {
    const workouts = await paginatedWorkouts(accessToken, startDate, endDate, credentials);
    const normalizedWorkouts = workouts.map(normalizeWorkout);
    const sleep = await fetchSleepEvents(accessToken, startDate, endDate, credentials);
    return [...normalizedWorkouts, ...sleep];
  },
  fetchDataPoints: async (accessToken, startDate, endDate, credentials) => {
    const recovery = await fetchSuuntoRecovery(accessToken, startDate, endDate, credentials);
    const activity = await fetchSuuntoActivity(accessToken, startDate, endDate, credentials);
    const daily = await fetchDailyStats(accessToken, startDate, endDate, credentials);
    return [...recovery, ...activity, ...daily];
  },
  fetchDailySummaries: async (accessToken, startDate, endDate, credentials) => {
    return aggregateDailySummaries(accessToken, startDate, endDate, credentials);
  },
};
