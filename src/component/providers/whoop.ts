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

const API_BASE = "https://api.prod.whoop.com";
const WHOOP_PER_PAGE = 25;
const WHOOP_SCOPE =
  "offline read:workout read:sleep read:recovery read:body_measurement read:profile";

interface WhoopWorkoutScore {
  average_heart_rate?: number;
  max_heart_rate?: number;
  kilojoule?: number;
  distance_meter?: number;
  altitude_gain_meter?: number;
}

interface WhoopWorkout {
  id: string;
  start: string;
  end: string;
  sport_name?: string;
  score_state?: string;
  score?: WhoopWorkoutScore;
}

interface WhoopWorkoutCollection {
  records?: WhoopWorkout[];
  next_token?: string;
  nextToken?: string;
}

interface WhoopSleepStageSummary {
  total_in_bed_time_milli?: number;
  total_awake_time_milli?: number;
  total_light_sleep_time_milli?: number;
  total_slow_wave_sleep_time_milli?: number;
  total_rem_sleep_time_milli?: number;
}

interface WhoopSleep {
  id: string;
  start: string;
  end: string;
  nap?: boolean;
  score_state?: string;
  score?: {
    sleep_efficiency_percentage?: number;
    stage_summary?: WhoopSleepStageSummary;
  };
}

interface WhoopSleepCollection {
  records?: WhoopSleep[];
  next_token?: string;
  nextToken?: string;
}

interface WhoopRecoveryRecord {
  id?: string;
  created_at?: string;
  score_state?: string;
  score?: {
    recovery_score?: number;
    resting_heart_rate?: number;
    hrv_rmssd_milli?: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
}

interface WhoopRecoveryCollection {
  records?: WhoopRecoveryRecord[];
  next_token?: string;
  nextToken?: string;
}

interface WhoopBodyMeasurement {
  height_meter?: number;
  weight_kilogram?: number;
}

// Workout type mappings translated from the upstream Python list.
const WHOOP_TYPE_MAP: Record<string, string> = {
  running: "running",
  walking: "walking",
  "hiking/rucking": "hiking",
  "track & field": "running",
  "stroller walking": "walking",
  "stroller jogging": "running",
  "dog walking": "walking",
  caddying: "walking",
  toddlerwearing: "walking",
  babywearing: "walking",
  cycling: "cycling",
  "mountain biking": "mountain_biking",
  spin: "indoor_cycling",
  "assault bike": "indoor_cycling",
  swimming: "swimming",
  "water polo": "water_polo",
  rowing: "rowing",
  kayaking: "kayaking",
  paddleboarding: "stand_up_paddleboarding",
  surfing: "surfing",
  sailing: "sailing",
  diving: "diving",
  "water skiing": "surfing",
  wakeboarding: "surfing",
  "kite boarding": "kitesurfing",
  "operations - water": "other",
  weightlifting: "strength_training",
  powerlifting: "strength_training",
  "strength trainer": "strength_training",
  "functional fitness": "cardio_training",
  elliptical: "elliptical",
  stairmaster: "stair_climbing",
  climber: "stair_climbing",
  "stadium steps": "stair_climbing",
  hiit: "cardio_training",
  "jumping rope": "cardio_training",
  "obstacle course racing": "cardio_training",
  parkour: "cardio_training",
  yoga: "yoga",
  "hot yoga": "yoga",
  pilates: "pilates",
  stretching: "stretching",
  meditation: "meditation",
  barre: "group_exercise",
  barre3: "group_exercise",
  skiing: "alpine_skiing",
  "cross country skiing": "cross_country_skiing",
  snowboarding: "snowboarding",
  "ice skating": "ice_skating",
  soccer: "soccer",
  basketball: "basketball",
  football: "american_football",
  "australian football": "football",
  "gaelic football": "football",
  baseball: "baseball",
  softball: "baseball",
  volleyball: "volleyball",
  rugby: "rugby",
  lacrosse: "lacrosse",
  cricket: "cricket",
  netball: "sport",
  ultimate: "sport",
  spikeball: "sport",
  "hurling/camogie": "sport",
  "ice hockey": "hockey",
  "field hockey": "hockey",
  tennis: "tennis",
  squash: "squash",
  badminton: "badminton",
  "table tennis": "table_tennis",
  padel: "padel",
  pickleball: "pickleball",
  "paddle tennis": "padel",
  boxing: "boxing",
  kickboxing: "boxing",
  "box fitness": "boxing",
  "martial arts": "martial_arts",
  "jiu jitsu": "martial_arts",
  wrestling: "wrestling",
  fencing: "martial_arts",
  "rock climbing": "rock_climbing",
  golf: "golf",
  "disc golf": "golf",
  "inline skating": "inline_skating",
  skateboarding: "skateboarding",
  "horseback riding": "horseback_riding",
  polo: "horseback_riding",
  triathlon: "triathlon",
  duathlon: "multisport",
  motocross: "motorcycling",
  "motor racing": "motor_sports",
  dance: "dance",
  "circus arts": "dance",
  "stage performance": "dance",
  "f45 training": "group_exercise",
  "barry's": "group_exercise",
  gymnastics: "gymnastics",
  handball: "handball",
  "ice bath": "other",
  sauna: "other",
  "massage therapy": "other",
  "air compression": "other",
  "percussive massage": "other",
  "operations - tactical": "other",
  "operations - medical": "other",
  "operations - flying": "other",
  "manual labor": "other",
  "high stress work": "other",
  coaching: "other",
  "watching sports": "other",
  commuting: "other",
  gaming: "other",
  "yard work": "other",
  cooking: "other",
  cleaning: "other",
  "public speaking": "other",
  "musical performance": "other",
  "dedicated parenting": "other",
  "wheelchair pushing": "walking",
  paintball: "sport",
  other: "other",
};

function toDateTime(ms: number): string {
  return new Date(ms).toISOString();
}

function parseTimestamp(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function buildUrlParams(params: Record<string, string | undefined>): Record<string, string> {
  const safe: Record<string, string> = {};
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) safe[key] = value;
  });
  return safe;
}

function normalizeWorkout(workout: WhoopWorkout): NormalizedEvent {
  const start = parseTimestamp(workout.start) ?? 0;
  const end = parseTimestamp(workout.end) ?? start;
  const score = workout.score;
  const durationSeconds = Math.max(Math.floor((end - start) / 1000), 0);

  const energy = score?.kilojoule !== undefined ? score.kilojoule * 0.239 : undefined;

  const type = workout.sport_name
    ? (WHOOP_TYPE_MAP[workout.sport_name.toLowerCase()] ?? "other")
    : "other";

  return {
    category: "workout",
    type,
    sourceName: "Whoop",
    source: "whoop",
    durationSeconds,
    startDatetime: start,
    endDatetime: end || start + durationSeconds * 1000,
    externalId: `whoop-workout-${workout.id}`,
    heartRateAvg: score?.average_heart_rate,
    heartRateMax: score?.max_heart_rate,
    energyBurned: energy,
    distance: score?.distance_meter,
    totalElevationGain: score?.altitude_gain_meter,
    movingTimeSeconds: durationSeconds,
    averageSpeed: undefined,
  };
}

function normalizeSleep(record: WhoopSleep): NormalizedEvent {
  const start = parseTimestamp(record.start) ?? 0;
  const end = parseTimestamp(record.end) ?? start;
  const stage = record.score?.stage_summary;
  const timeInBedMinutes = Math.round((stage?.total_in_bed_time_milli ?? end - start) / 60000);
  const awakeMinutes = Math.round((stage?.total_awake_time_milli ?? 0) / 60000);
  const deepMinutes = Math.round((stage?.total_slow_wave_sleep_time_milli ?? 0) / 60000);
  const remMinutes = Math.round((stage?.total_rem_sleep_time_milli ?? 0) / 60000);
  const lightMinutes = Math.round((stage?.total_light_sleep_time_milli ?? 0) / 60000);
  const totalSleepMinutes =
    deepMinutes + remMinutes + lightMinutes || Math.max(timeInBedMinutes - awakeMinutes, 0);

  return {
    category: "sleep",
    type: "sleep_session",
    sourceName: "Whoop",
    source: "whoop",
    durationSeconds: Math.max(Math.floor((end - start) / 1000), 0),
    startDatetime: start,
    endDatetime: end,
    externalId: `whoop-sleep-${record.id}`,
    sleepTotalDurationMinutes: totalSleepMinutes,
    sleepTimeInBedMinutes: timeInBedMinutes,
    sleepEfficiencyScore: record.score?.sleep_efficiency_percentage,
    sleepDeepMinutes: deepMinutes || undefined,
    sleepRemMinutes: remMinutes || undefined,
    sleepLightMinutes: lightMinutes || undefined,
    sleepAwakeMinutes: awakeMinutes || undefined,
    isNap: record.nap,
  };
}

function normalizeRecovery(record: WhoopRecoveryRecord): NormalizedDataPoint[] {
  if (record.score_state && record.score_state !== "SCORED") {
    return [];
  }

  const createdAt = parseTimestamp(record.created_at) ?? Date.now();
  const score = record.score;
  if (!score) return [];

  const points: NormalizedDataPoint[] = [];

  if (score.recovery_score !== undefined) {
    points.push({
      seriesType: "recovery_score",
      recordedAt: createdAt,
      value: score.recovery_score,
    });
  }

  if (score.resting_heart_rate !== undefined) {
    points.push({
      seriesType: "resting_heart_rate",
      recordedAt: createdAt,
      value: score.resting_heart_rate,
    });
  }

  if (score.hrv_rmssd_milli !== undefined) {
    points.push({
      seriesType: "heart_rate_variability_rmssd",
      recordedAt: createdAt,
      value: score.hrv_rmssd_milli,
    });
  }

  if (score.spo2_percentage !== undefined) {
    points.push({
      seriesType: "oxygen_saturation",
      recordedAt: createdAt,
      value: score.spo2_percentage,
    });
  }

  if (score.skin_temp_celsius !== undefined) {
    points.push({
      seriesType: "skin_temperature",
      recordedAt: createdAt,
      value: score.skin_temp_celsius,
    });
  }

  return points;
}

function normalizeBodyMeasurement(body: WhoopBodyMeasurement): NormalizedDataPoint[] {
  const now = Date.now();
  const points: NormalizedDataPoint[] = [];

  if (body.height_meter !== undefined) {
    points.push({
      seriesType: "height",
      recordedAt: now,
      value: body.height_meter * 100,
    });
  }

  if (body.weight_kilogram !== undefined) {
    points.push({
      seriesType: "weight",
      recordedAt: now,
      value: body.weight_kilogram,
    });
  }

  return points;
}

async function fetchPaged<T extends { records?: unknown; next_token?: string; nextToken?: string }>(
  accessToken: string,
  endpoint: string,
  params: Record<string, string>,
): Promise<T[]> {
  const all: T[] = [];
  let nextToken: string | undefined;

  while (true) {
    const response = await makeAuthenticatedRequest<T>(API_BASE, endpoint, accessToken, {
      params: buildUrlParams({
        ...params,
        limit: String(WHOOP_PER_PAGE),
        nextToken,
      }),
    });

    all.push(response);
    nextToken = response.next_token ?? response.nextToken;
    if (!nextToken) break;
  }

  return all;
}

async function fetchWhoopWorkouts(
  accessToken: string,
  startDate: number,
  endDate: number,
): Promise<NormalizedEvent[]> {
  const records: NormalizedEvent[] = [];
  const startIso = toDateTime(startDate);
  const endIso = toDateTime(endDate);

  const responses = await fetchPaged<WhoopWorkoutCollection>(accessToken, "/v2/activity/workout", {
    start: startIso,
    end: endIso,
  });

  for (const res of responses) {
    for (const workout of res.records ?? []) {
      if (workout.score_state === "SCORED" || !workout.score_state) {
        records.push(normalizeWorkout(workout));
      }
    }
  }

  return records;
}

async function fetchWhoopSleep(
  accessToken: string,
  startDate: number,
  endDate: number,
): Promise<NormalizedEvent[]> {
  const records: NormalizedEvent[] = [];
  const startIso = toDateTime(startDate);
  const endIso = toDateTime(endDate);

  const responses = await fetchPaged<WhoopSleepCollection>(accessToken, "/v2/activity/sleep", {
    start: startIso,
    end: endIso,
  });

  for (const res of responses) {
    for (const sleep of res.records ?? []) {
      if (sleep.score_state === "SCORED" || !sleep.score_state) {
        records.push(normalizeSleep(sleep));
      }
    }
  }

  return records;
}

async function fetchWhoopRecovery(
  accessToken: string,
  startDate: number,
  endDate: number,
): Promise<NormalizedDataPoint[]> {
  const points: NormalizedDataPoint[] = [];
  const startIso = toDateTime(startDate);
  const endIso = toDateTime(endDate);

  const responses = await fetchPaged<WhoopRecoveryCollection>(accessToken, "/v2/recovery", {
    start: startIso,
    end: endIso,
  });

  for (const res of responses) {
    for (const record of res.records ?? []) {
      points.push(...normalizeRecovery(record));
    }
  }

  return points;
}

async function fetchWhoopBodyMeasurement(accessToken: string): Promise<NormalizedDataPoint[]> {
  try {
    const measurement = await makeAuthenticatedRequest<WhoopBodyMeasurement>(
      API_BASE,
      "/v2/user/measurement/body",
      accessToken,
    );
    return normalizeBodyMeasurement(measurement);
  } catch {
    return [];
  }
}

function aggregateDailySummaries(
  events: NormalizedEvent[],
  dataPoints: NormalizedDataPoint[],
): NormalizedDailySummary[] {
  const sleepByDate = new Map<string, NormalizedDailySummary>();
  const recoveryByDate = new Map<string, { counts: Record<string, number[]> }>();
  const bodyByDate = new Map<string, NormalizedDailySummary>();

  const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  for (const event of events) {
    if (event.category !== "sleep" || !event.startDatetime) continue;
    const date = toDate(event.startDatetime);
    const summary = sleepByDate.get(date) ?? {
      date,
      category: "sleep",
    };

    summary.sleepDurationMinutes = Math.max(
      summary.sleepDurationMinutes ?? 0,
      event.sleepTotalDurationMinutes ?? 0,
    );
    summary.sleepEfficiency = event.sleepEfficiencyScore ?? summary.sleepEfficiency;
    summary.deepSleepMinutes = event.sleepDeepMinutes ?? summary.deepSleepMinutes;
    summary.remSleepMinutes = event.sleepRemMinutes ?? summary.remSleepMinutes;
    summary.lightSleepMinutes = event.sleepLightMinutes ?? summary.lightSleepMinutes;
    summary.awakeDuringMinutes = event.sleepAwakeMinutes ?? summary.awakeDuringMinutes;
    summary.timeInBedMinutes = event.sleepTimeInBedMinutes ?? summary.timeInBedMinutes;

    sleepByDate.set(date, summary);
  }

  for (const point of dataPoints) {
    const date = toDate(point.recordedAt);
    const data = recoveryByDate.get(date) ?? { counts: {} };
    const bucket = data.counts[point.seriesType] ?? [];
    bucket.push(point.value);
    data.counts[point.seriesType] = bucket;
    recoveryByDate.set(date, data);

    if (point.seriesType === "weight") {
      const existing = bodyByDate.get(date) ?? {
        date,
        category: "body",
      };
      existing.weight = point.value;
      bodyByDate.set(date, existing);
    }
  }

  const recoverySummaries: NormalizedDailySummary[] = [];
  for (const [date, data] of recoveryByDate.entries()) {
    const summary: NormalizedDailySummary = { date, category: "recovery" };
    const average = (list: number[]) =>
      list.length ? list.reduce((a, b) => a + b, 0) / list.length : undefined;

    summary.recoveryScore = average(data.counts.recovery_score ?? []);
    summary.restingHeartRate = average(data.counts.resting_heart_rate ?? []);
    summary.hrvRmssd = average(data.counts.heart_rate_variability_rmssd ?? []);
    summary.spo2Avg = average(data.counts.oxygen_saturation ?? []);
    recoverySummaries.push(summary);
  }

  return [...sleepByDate.values(), ...recoverySummaries, ...bodyByDate.values()];
}

export function whoopOAuthConfig(credentials: ProviderCredentials): OAuthProviderConfig {
  return {
    endpoints: {
      authorizeUrl: "https://api.prod.whoop.com/oauth/oauth2/auth",
      tokenUrl: "https://api.prod.whoop.com/oauth/oauth2/token",
      apiBaseUrl: API_BASE,
    },
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    defaultScope: WHOOP_SCOPE,
    usePkce: false,
    authMethod: "body",
  };
}

async function fetchWhoopUserInfo(accessToken: string): Promise<ProviderUserInfo> {
  try {
    const profile = await makeAuthenticatedRequest<{ user_id?: string | number; email?: string }>(
      API_BASE,
      "/v2/user/profile/basic",
      accessToken,
    );
    return {
      providerUserId: profile.user_id !== undefined ? String(profile.user_id) : null,
      username: profile.email ?? null,
    };
  } catch {
    return { providerUserId: null, username: null };
  }
}

export const whoopProvider: ProviderAdapter = {
  name: "whoop",
  oauthConfig: whoopOAuthConfig,
  getUserInfo: async (accessToken) => fetchWhoopUserInfo(accessToken),
  fetchEvents: async (accessToken, startDate, endDate) => {
    const workouts = await fetchWhoopWorkouts(accessToken, startDate, endDate);
    const sleeps = await fetchWhoopSleep(accessToken, startDate, endDate);
    return [...workouts, ...sleeps];
  },
  fetchDataPoints: async (accessToken, startDate, endDate) => {
    const recovery = await fetchWhoopRecovery(accessToken, startDate, endDate);
    const body = await fetchWhoopBodyMeasurement(accessToken);
    return [...recovery, ...body];
  },
  fetchDailySummaries: async (accessToken, startDate, endDate) => {
    const events = (await whoopProvider.fetchEvents?.(accessToken, startDate, endDate)) ?? [];
    const points = (await whoopProvider.fetchDataPoints?.(accessToken, startDate, endDate)) ?? [];
    return aggregateDailySummaries(events, points);
  },
};
