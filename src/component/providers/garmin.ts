/**
 * Garmin provider adapter.
 *
 * Garmin is a push-based provider: after OAuth 2.0 authorization (with PKCE),
 * Garmin pushes data to registered webhook endpoints.
 *
 * This module handles:
 * - OAuth config (OAuth 2.0 + PKCE)
 * - Activity normalization (push webhook payloads)
 * - Sleep normalization
 * - Daily summary normalization
 * - Epoch (15-min interval) normalization
 * - Body composition normalization
 */

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

// ---------------------------------------------------------------------------
// OAuth config
// ---------------------------------------------------------------------------

const API_BASE = "https://apis.garmin.com";

export function garminOAuthConfig(credentials: ProviderCredentials): OAuthProviderConfig {
  return {
    endpoints: {
      authorizeUrl: "https://connect.garmin.com/oauth2Confirm",
      tokenUrl: "https://connectapi.garmin.com/di-oauth2-service/oauth/token",
      apiBaseUrl: API_BASE,
    },
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    defaultScope: "", // Scope is managed at app creation in Garmin Developer Portal
    usePkce: true,
    authMethod: "body",
  };
}

// ---------------------------------------------------------------------------
// Garmin API types (push webhook payloads)
// ---------------------------------------------------------------------------

export interface GarminActivitySummaryData {
  activityId?: number | string;
  summaryId?: string;
  activityName?: string;
  activityType?: string;
  startTimeInSeconds?: number | string;
  startTimeOffsetInSeconds?: number | string;
  durationInSeconds?: number | string;
  deviceName?: string;
  distanceInMeters?: number;
  steps?: number;
  activeKilocalories?: number;
  averageHeartRateInBeatsPerMinute?: number;
  maxHeartRateInBeatsPerMinute?: number;
  averageSpeedInMetersPerSecond?: number;
  maxSpeedInMetersPerSecond?: number;
  averagePowerInWatts?: number;
  maxPowerInWatts?: number;
  totalElevationGainInMeters?: number;
  elapsedDurationInSeconds?: number;
  movingDurationInSeconds?: number;
  manual?: boolean;
}

export interface GarminActivity extends GarminActivitySummaryData {
  userId: string;
  activityId: number | string;
  summary?: GarminActivitySummaryData;
}

export interface GarminSleep {
  userId: string;
  summaryId: string;
  startTimeInSeconds: number;
  startTimeOffsetInSeconds?: number;
  durationInSeconds: number;
  deepSleepDurationInSeconds?: number;
  lightSleepDurationInSeconds?: number;
  remSleepInSeconds?: number;
  awakeDurationInSeconds?: number;
  averageHeartRate?: number;
  lowestHeartRate?: number;
  avgOxygenSaturation?: number;
  respirationAvg?: number;
  overallSleepScore?: { value?: number };
  validation?: string;
  sleepLevelsMap?: Record<string, Array<{ startTimeInSeconds: number; endTimeInSeconds: number }>>;
}

export interface GarminDaily {
  userId: string;
  summaryId: string;
  startTimeInSeconds: number;
  durationInSeconds: number;
  calendarDate?: string;
  steps?: number;
  distanceInMeters?: number;
  activeKilocalories?: number;
  bmrKilocalories?: number;
  floorsClimbed?: number;
  minHeartRateInBeatsPerMinute?: number;
  maxHeartRateInBeatsPerMinute?: number;
  averageHeartRateInBeatsPerMinute?: number;
  restingHeartRateInBeatsPerMinute?: number;
  averageStressLevel?: number;
  bodyBatteryChargedValue?: number;
  bodyBatteryDrainedValue?: number;
  moderateIntensityDurationInSeconds?: number;
  vigorousIntensityDurationInSeconds?: number;
  timeOffsetHeartRateSamples?: Record<string, number>;
}

export interface GarminEpoch {
  userId: string;
  summaryId: string;
  startTimeInSeconds: number;
  durationInSeconds: number;
  steps?: number;
  distanceInMeters?: number;
  activeKilocalories?: number;
  meanHeartRateInBeatsPerMinute?: number;
  maxHeartRateInBeatsPerMinute?: number;
  intensity?: string;
}

export interface GarminBodyComp {
  userId: string;
  summaryId: string;
  measurementTimeInSeconds: number;
  weightInGrams?: number;
  bodyFatInPercent?: number;
  bodyMassIndex?: number;
  muscleMassInGrams?: number;
}

export interface GarminHrv {
  userId: string;
  summaryId?: string;
  startTimeInSeconds: number;
  calendarDate?: string;
  lastNightAvg?: number;
  hrvValues?: Record<string, number>;
}

export interface GarminStressDetails {
  userId: string;
  summaryId?: string;
  startTimeInSeconds: number;
  stressLevelValues?: Record<string, number>;
  bodyBatteryValues?: Record<string, number>;
}

export interface GarminRespiration {
  userId: string;
  summaryId?: string;
  startTimeInSeconds: number;
  calendarDate?: string;
  avgWakingRespirationValue?: number;
  timeOffsetRespirationRateValues?: Record<string, number>;
  timeOffsetRespirationValues?: Record<string, number>;
}

export interface GarminPulseOx {
  userId: string;
  summaryId?: string;
  startTimeInSeconds: number;
  calendarDate?: string;
  avgSpo2?: number;
  timeOffsetSpo2Values?: Record<string, number>;
}

export interface GarminBloodPressure {
  userId: string;
  summaryId?: string;
  measurementTimestampGMT?: number;
  startTimeInSeconds?: number;
  systolic?: number;
  diastolic?: number;
}

export interface GarminUserMetrics {
  userId: string;
  summaryId?: string;
  calendarDate?: string;
  vo2Max?: number;
  fitnessAge?: number;
}

export interface GarminSkinTemp {
  userId: string;
  summaryId?: string;
  startTimeInSeconds: number;
  skinTemperature?: number;
}

export interface GarminHealthSnapshot {
  userId: string;
  summaryId?: string;
  startTimeInSeconds: number;
  heartRate?: number;
  hrv?: number;
  stress?: number;
  spo2?: number;
  respiration?: number;
}

export interface GarminMoveIQ {
  userId: string;
  summaryId?: string;
  startTimeInSeconds: number;
  durationInSeconds?: number;
  activityType?: string;
}

export interface GarminMCTSummary {
  userId: string;
  summaryId: string;
  startTimeInSeconds?: number;
  startTimeOffsetInSeconds?: number;
  periodStartDateStr?: string; // "2026-03-01" ISO date
  dayInCycle?: number;
  cycleLength?: number;
  predictedCycleLength?: number;
  periodLength?: number;
  currentPhase?: number; // numeric phase ID
  currentPhaseType?: string; // "MENSTRUAL", "FOLLICULAR", "OVULATION", "LUTEAL", etc.
  lengthOfCurrentPhase?: number;
  daysUntilNextPhase?: number;
  isPredictedCycle?: boolean;
  fertileWindowStart?: number;
  lengthOfFertileWindow?: number;
  lastUpdatedAt?: number; // unix seconds
  isPregnant?: boolean;
  pregnancyDueDate?: string; // "2026-09-15" ISO date
  pregnancyOriginalDueDate?: string;
  pregnancyCycleStartDate?: string;
  pregnancyTitle?: string;
  numberOfBabies?: string; // "SINGLE", "TWINS", etc.
}

export interface GarminPushPayload {
  activities?: GarminActivity[];
  activityDetails?: GarminActivity[];
  sleeps?: GarminSleep[];
  dailies?: GarminDaily[];
  epochs?: GarminEpoch[];
  bodyComps?: GarminBodyComp[];
  hrv?: GarminHrv[];
  stressDetails?: GarminStressDetails[];
  respiration?: GarminRespiration[];
  pulseOx?: GarminPulseOx[];
  bloodPressures?: GarminBloodPressure[];
  userMetrics?: GarminUserMetrics[];
  skinTemp?: GarminSkinTemp[];
  healthSnapshot?: GarminHealthSnapshot[];
  moveiq?: GarminMoveIQ[];
  menstrualCycleTracking?: GarminMCTSummary[];
  mct?: GarminMCTSummary[];
  deregistrations?: Array<{ userId: string }>;
  userPermissionsChange?: Array<{ userId: string; permissions: string[] }>;
}

function isoDateFromTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString().split("T")[0] ?? "";
}

function isoDateFromCalendarDate(
  calendarDate: string | undefined,
  fallbackTimestampMs: number,
): string {
  return calendarDate ?? isoDateFromTimestamp(fallbackTimestampMs);
}

function calendarDateToMiddayTimestamp(calendarDate: string | undefined): number | null {
  if (!calendarDate) {
    return null;
  }

  const timestamp = Date.parse(`${calendarDate}T12:00:00Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildOffsetDataPoints(
  values: Record<string, number> | undefined,
  startTimeInSeconds: number,
  seriesType: string,
  externalIdPrefix?: string,
): NormalizedDataPoint[] {
  if (!values) {
    return [];
  }

  return Object.entries(values).reduce<NormalizedDataPoint[]>((points, [offsetStr, value]) => {
    const offsetSeconds = Number(offsetStr);
    if (!Number.isFinite(offsetSeconds) || !Number.isFinite(value)) {
      return points;
    }

    points.push({
      seriesType,
      recordedAt: (startTimeInSeconds + offsetSeconds) * 1000,
      value,
      externalId: externalIdPrefix ? `${externalIdPrefix}:${offsetStr}` : undefined,
    });

    return points;
  }, []);
}

// ---------------------------------------------------------------------------
// Workout type mapping (Garmin activityType → unified type)
// ---------------------------------------------------------------------------

const WORKOUT_TYPE_MAP: Record<string, string> = {
  RUNNING: "running",
  TRAIL_RUNNING: "trail_running",
  TREADMILL_RUNNING: "treadmill",
  VIRTUAL_RUN: "running",
  INDOOR_RUNNING: "treadmill",
  CYCLING: "cycling",
  MOUNTAIN_BIKING: "mountain_biking",
  GRAVEL_CYCLING: "cycling",
  INDOOR_CYCLING: "indoor_cycling",
  VIRTUAL_RIDE: "indoor_cycling",
  ROAD_BIKING: "cycling",
  BMX: "cycling",
  RECUMBENT_CYCLING: "cycling",
  E_BIKE_MOUNTAIN: "e_biking",
  E_BIKE_FITNESS: "e_biking",
  SWIMMING: "swimming",
  LAP_SWIMMING: "swimming",
  OPEN_WATER_SWIMMING: "open_water_swimming",
  POOL_SWIM: "swimming",
  HIKING: "hiking",
  WALKING: "walking",
  CASUAL_WALKING: "walking",
  SPEED_WALKING: "walking",
  YOGA: "yoga",
  PILATES: "pilates",
  STRENGTH_TRAINING: "strength_training",
  CARDIO_TRAINING: "cardio_training",
  ELLIPTICAL: "elliptical",
  STAIR_CLIMBING: "stair_climbing",
  INDOOR_ROWING: "rowing_machine",
  ROWING: "rowing",
  KAYAKING: "kayaking",
  STAND_UP_PADDLEBOARDING: "stand_up_paddleboarding",
  SURFING: "surfing",
  KITEBOARDING: "kitesurfing",
  WINDSURFING: "windsurfing",
  SAILING: "sailing",
  TENNIS: "tennis",
  TABLE_TENNIS: "table_tennis",
  PICKLEBALL: "pickleball",
  BADMINTON: "badminton",
  SQUASH: "squash",
  RACQUETBALL: "squash",
  PADEL: "padel",
  SOCCER: "soccer",
  BASKETBALL: "basketball",
  VOLLEYBALL: "volleyball",
  FOOTBALL: "football",
  BASEBALL: "baseball",
  SOFTBALL: "softball",
  RUGBY: "rugby",
  HOCKEY: "hockey",
  LACROSSE: "lacrosse",
  CRICKET: "cricket",
  GOLF: "golf",
  DISC_GOLF: "golf",
  ROCK_CLIMBING: "rock_climbing",
  BOULDERING: "rock_climbing",
  INDOOR_CLIMBING: "rock_climbing",
  SKATEBOARDING: "skateboarding",
  INLINE_SKATING: "inline_skating",
  ICE_SKATING: "ice_skating",
  SKIING: "alpine_skiing",
  RESORT_SKIING_SNOWBOARDING: "alpine_skiing",
  BACKCOUNTRY_SKIING_SNOWBOARDING: "backcountry_skiing",
  CROSS_COUNTRY_SKIING: "cross_country_skiing",
  SNOWBOARDING: "snowboarding",
  SNOWSHOEING: "snowshoeing",
  BOXING: "boxing",
  MARTIAL_ARTS: "martial_arts",
  JUMP_ROPE: "jump_rope",
  HIIT: "cardio_training",
  FITNESS_EQUIPMENT: "cardio_training",
  BREATHWORK: "breathwork",
  MEDITATION: "meditation",
  OTHER: "other",
};

function getUnifiedWorkoutType(activityType: string): string {
  return WORKOUT_TYPE_MAP[activityType.trim().toUpperCase()] ?? "other";
}

function coerceFiniteNumber(value: number | string | undefined): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const numericValue = Number(trimmed);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function parseGarminTimestampMs(value: number | string | undefined): number | null {
  const numericValue = coerceFiniteNumber(value);
  if (numericValue != null) {
    return numericValue * 1000;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getActivitySummary(activity: GarminActivity): GarminActivitySummaryData {
  return activity.summary ?? activity;
}

// ---------------------------------------------------------------------------
// Normalization — Activities
// ---------------------------------------------------------------------------

export function normalizeActivity(activity: GarminActivity): NormalizedEvent | null {
  const summary = getActivitySummary(activity);
  const startMs = parseGarminTimestampMs(summary.startTimeInSeconds);
  const durationSeconds = coerceFiniteNumber(summary.durationInSeconds);

  if (startMs == null || durationSeconds == null) {
    return null;
  }

  const activityId = activity.activityId ?? summary.activityId;
  const endMs = startMs + durationSeconds * 1000;

  return {
    category: "workout",
    type: summary.activityType ? getUnifiedWorkoutType(summary.activityType) : "other",
    sourceName: summary.deviceName ?? "Garmin",
    deviceModel: summary.deviceName,
    durationSeconds,
    startDatetime: startMs,
    endDatetime: endMs,
    externalId: activityId != null ? `garmin-${activityId}` : undefined,

    heartRateAvg: summary.averageHeartRateInBeatsPerMinute,
    heartRateMax: summary.maxHeartRateInBeatsPerMinute,
    energyBurned: summary.activeKilocalories,
    distance: summary.distanceInMeters,
    stepsCount: summary.steps,
    averageSpeed: summary.averageSpeedInMetersPerSecond,
    maxSpeed: summary.maxSpeedInMetersPerSecond,
    averageWatts: summary.averagePowerInWatts,
    maxWatts: summary.maxPowerInWatts,
    totalElevationGain: summary.totalElevationGainInMeters,
    movingTimeSeconds: summary.movingDurationInSeconds,
  };
}

// ---------------------------------------------------------------------------
// Normalization — Sleep
// ---------------------------------------------------------------------------

export function normalizeSleep(sleep: GarminSleep): NormalizedEvent {
  const startMs = sleep.startTimeInSeconds * 1000;
  const endMs = startMs + sleep.durationInSeconds * 1000;

  // Build sleep stages from sleepLevelsMap if available
  let sleepStages: { stage: string; startTime: number; endTime: number }[] | undefined;
  if (sleep.sleepLevelsMap) {
    sleepStages = [];
    const stageMapping: Record<string, string> = {
      deep: "deep",
      light: "light",
      rem: "rem",
      awake: "awake",
    };
    for (const [key, intervals] of Object.entries(sleep.sleepLevelsMap)) {
      const stage = stageMapping[key] ?? key;
      for (const interval of intervals) {
        sleepStages.push({
          stage,
          startTime: interval.startTimeInSeconds * 1000,
          endTime: interval.endTimeInSeconds * 1000,
        });
      }
    }
    // Sort by start time
    sleepStages.sort((a, b) => a.startTime - b.startTime);
  }

  return {
    category: "sleep",
    type: "sleep_session",
    sourceName: "Garmin",
    durationSeconds: sleep.durationInSeconds,
    startDatetime: startMs,
    endDatetime: endMs,
    externalId: `garmin-sleep-${sleep.summaryId}`,

    heartRateAvg: sleep.averageHeartRate,
    heartRateMin: sleep.lowestHeartRate,
    sleepTotalDurationMinutes: Math.floor(sleep.durationInSeconds / 60),
    sleepDeepMinutes: sleep.deepSleepDurationInSeconds
      ? Math.floor(sleep.deepSleepDurationInSeconds / 60)
      : undefined,
    sleepLightMinutes: sleep.lightSleepDurationInSeconds
      ? Math.floor(sleep.lightSleepDurationInSeconds / 60)
      : undefined,
    sleepRemMinutes: sleep.remSleepInSeconds ? Math.floor(sleep.remSleepInSeconds / 60) : undefined,
    sleepAwakeMinutes: sleep.awakeDurationInSeconds
      ? Math.floor(sleep.awakeDurationInSeconds / 60)
      : undefined,
    sleepEfficiencyScore: sleep.overallSleepScore?.value,
    sleepStages,
  };
}

export function normalizeSleepSummary(sleep: GarminSleep): NormalizedDailySummary {
  return {
    date: isoDateFromTimestamp(sleep.startTimeInSeconds * 1000),
    category: "sleep",
    sleepDurationMinutes: Math.floor(sleep.durationInSeconds / 60),
    sleepEfficiency: sleep.overallSleepScore?.value,
    deepSleepMinutes: sleep.deepSleepDurationInSeconds
      ? Math.floor(sleep.deepSleepDurationInSeconds / 60)
      : undefined,
    lightSleepMinutes: sleep.lightSleepDurationInSeconds
      ? Math.floor(sleep.lightSleepDurationInSeconds / 60)
      : undefined,
    remSleepMinutes: sleep.remSleepInSeconds ? Math.floor(sleep.remSleepInSeconds / 60) : undefined,
    awakeDuringMinutes: sleep.awakeDurationInSeconds
      ? Math.floor(sleep.awakeDurationInSeconds / 60)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Normalization — Daily Summary
// ---------------------------------------------------------------------------

export interface GarminDailySummaryNormalized {
  userId: string;
  date: string;
  totalSteps?: number;
  totalCalories?: number;
  activeCalories?: number;
  totalDistance?: number;
  floorsClimbed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  restingHeartRate?: number;
  avgStressLevel?: number;
  bodyBattery?: number;
  activeMinutes?: number;
  /** Heart rate samples: { timestampMs: bpm } */
  heartRateSamples?: { timestamp: number; value: number }[];
}

export function normalizeDaily(daily: GarminDaily): GarminDailySummaryNormalized {
  const activeMinutes =
    ((daily.moderateIntensityDurationInSeconds ?? 0) +
      (daily.vigorousIntensityDurationInSeconds ?? 0)) /
      60 || undefined;

  // Parse heart rate time-offset samples into absolute timestamps
  let heartRateSamples: { timestamp: number; value: number }[] | undefined;
  if (daily.timeOffsetHeartRateSamples) {
    const baseMs = daily.startTimeInSeconds * 1000;
    heartRateSamples = Object.entries(daily.timeOffsetHeartRateSamples).map(([offsetStr, bpm]) => ({
      timestamp: baseMs + Number(offsetStr) * 1000,
      value: bpm,
    }));
  }

  const totalCalories =
    daily.activeKilocalories != null && daily.bmrKilocalories != null
      ? daily.activeKilocalories + daily.bmrKilocalories
      : daily.activeKilocalories;

  return {
    userId: daily.userId,
    date:
      daily.calendarDate ?? new Date(daily.startTimeInSeconds * 1000).toISOString().split("T")[0],
    totalSteps: daily.steps,
    totalCalories,
    activeCalories: daily.activeKilocalories,
    totalDistance: daily.distanceInMeters,
    floorsClimbed: daily.floorsClimbed,
    avgHeartRate: daily.averageHeartRateInBeatsPerMinute,
    maxHeartRate: daily.maxHeartRateInBeatsPerMinute,
    minHeartRate: daily.minHeartRateInBeatsPerMinute,
    restingHeartRate: daily.restingHeartRateInBeatsPerMinute,
    avgStressLevel: daily.averageStressLevel,
    bodyBattery:
      daily.bodyBatteryChargedValue != null && daily.bodyBatteryDrainedValue != null
        ? daily.bodyBatteryChargedValue - daily.bodyBatteryDrainedValue
        : undefined,
    activeMinutes: activeMinutes ? Math.round(activeMinutes) : undefined,
    heartRateSamples,
  };
}

export function normalizeDailyRecoverySummary(daily: GarminDaily): NormalizedDailySummary {
  const normalized = normalizeDaily(daily);
  return {
    date: normalized.date,
    category: "recovery",
    restingHeartRate: normalized.restingHeartRate,
    avgStressLevel: normalized.avgStressLevel,
    bodyBattery: normalized.bodyBattery,
  };
}

export function normalizeEpochDataPoints(epoch: GarminEpoch): NormalizedDataPoint[] {
  const recordedAt = epoch.startTimeInSeconds * 1000;
  const points: NormalizedDataPoint[] = [];

  if (epoch.meanHeartRateInBeatsPerMinute != null) {
    points.push({
      seriesType: "heart_rate",
      recordedAt,
      value: epoch.meanHeartRateInBeatsPerMinute,
      externalId: epoch.summaryId ? `${epoch.summaryId}:heart_rate` : undefined,
    });
  }

  if (epoch.steps != null) {
    points.push({
      seriesType: "steps",
      recordedAt,
      value: epoch.steps,
      externalId: epoch.summaryId ? `${epoch.summaryId}:steps` : undefined,
    });
  }

  if (epoch.activeKilocalories != null) {
    points.push({
      seriesType: "energy",
      recordedAt,
      value: epoch.activeKilocalories,
      externalId: epoch.summaryId ? `${epoch.summaryId}:energy` : undefined,
    });
  }

  return points;
}

export function normalizeBodyCompositionDataPoints(
  bodyComp: GarminBodyComp,
): NormalizedDataPoint[] {
  const recordedAt = bodyComp.measurementTimeInSeconds * 1000;
  const points: NormalizedDataPoint[] = [];

  if (bodyComp.weightInGrams != null) {
    points.push({
      seriesType: "weight",
      recordedAt,
      value: bodyComp.weightInGrams / 1000,
      externalId: bodyComp.summaryId ? `${bodyComp.summaryId}:weight` : undefined,
    });
  }

  if (bodyComp.bodyFatInPercent != null) {
    points.push({
      seriesType: "body_fat_percentage",
      recordedAt,
      value: bodyComp.bodyFatInPercent,
      externalId: bodyComp.summaryId ? `${bodyComp.summaryId}:body_fat_percentage` : undefined,
    });
  }

  if (bodyComp.bodyMassIndex != null) {
    points.push({
      seriesType: "body_mass_index",
      recordedAt,
      value: bodyComp.bodyMassIndex,
      externalId: bodyComp.summaryId ? `${bodyComp.summaryId}:body_mass_index` : undefined,
    });
  }

  if (bodyComp.muscleMassInGrams != null) {
    points.push({
      seriesType: "skeletal_muscle_mass",
      recordedAt,
      value: bodyComp.muscleMassInGrams / 1000,
      externalId: bodyComp.summaryId ? `${bodyComp.summaryId}:skeletal_muscle_mass` : undefined,
    });
  }

  return points;
}

export function normalizeBodyCompositionSummary(bodyComp: GarminBodyComp): NormalizedDailySummary {
  return {
    date: isoDateFromTimestamp(bodyComp.measurementTimeInSeconds * 1000),
    category: "body",
    weight: bodyComp.weightInGrams != null ? bodyComp.weightInGrams / 1000 : undefined,
    bodyFatPercentage: bodyComp.bodyFatInPercent,
    bodyMassIndex: bodyComp.bodyMassIndex,
  };
}

export function normalizeHrvDataPoints(hrv: GarminHrv): NormalizedDataPoint[] {
  if (!hrv.startTimeInSeconds) {
    return [];
  }

  const points: NormalizedDataPoint[] = [];
  if (hrv.lastNightAvg != null) {
    points.push({
      seriesType: "heart_rate_variability_sdnn",
      recordedAt: hrv.startTimeInSeconds * 1000,
      value: hrv.lastNightAvg,
      externalId: hrv.summaryId,
    });
  }

  points.push(
    ...buildOffsetDataPoints(
      hrv.hrvValues,
      hrv.startTimeInSeconds,
      "heart_rate_variability_sdnn",
      hrv.summaryId,
    ),
  );

  return points;
}

export function normalizeHrvSummary(hrv: GarminHrv): NormalizedDailySummary | null {
  if (hrv.lastNightAvg == null || !hrv.startTimeInSeconds) {
    return null;
  }

  return {
    date: isoDateFromCalendarDate(hrv.calendarDate, hrv.startTimeInSeconds * 1000),
    category: "recovery",
    hrvAvg: hrv.lastNightAvg,
  };
}

export function normalizeStressDataPoints(stress: GarminStressDetails): NormalizedDataPoint[] {
  if (!stress.startTimeInSeconds) {
    return [];
  }

  return [
    ...buildOffsetDataPoints(
      stress.stressLevelValues,
      stress.startTimeInSeconds,
      "garmin_stress_level",
      stress.summaryId ? `${stress.summaryId}:stress` : undefined,
    ),
    ...buildOffsetDataPoints(
      stress.bodyBatteryValues,
      stress.startTimeInSeconds,
      "garmin_body_battery",
      stress.summaryId ? `${stress.summaryId}:body_battery` : undefined,
    ),
  ];
}

export function normalizeRespirationDataPoints(
  respiration: GarminRespiration,
): NormalizedDataPoint[] {
  if (!respiration.startTimeInSeconds) {
    return [];
  }

  const points: NormalizedDataPoint[] = [];
  if (respiration.avgWakingRespirationValue != null) {
    points.push({
      seriesType: "respiratory_rate",
      recordedAt: respiration.startTimeInSeconds * 1000,
      value: respiration.avgWakingRespirationValue,
      externalId: respiration.summaryId,
    });
  }

  points.push(
    ...buildOffsetDataPoints(
      respiration.timeOffsetRespirationRateValues ?? respiration.timeOffsetRespirationValues,
      respiration.startTimeInSeconds,
      "respiratory_rate",
      respiration.summaryId,
    ),
  );

  return points;
}

export function normalizePulseOxDataPoints(pulseOx: GarminPulseOx): NormalizedDataPoint[] {
  if (!pulseOx.startTimeInSeconds) {
    return [];
  }

  const points: NormalizedDataPoint[] = [];
  if (pulseOx.avgSpo2 != null) {
    points.push({
      seriesType: "oxygen_saturation",
      recordedAt: pulseOx.startTimeInSeconds * 1000,
      value: pulseOx.avgSpo2,
      externalId: pulseOx.summaryId,
    });
  }

  points.push(
    ...buildOffsetDataPoints(
      pulseOx.timeOffsetSpo2Values,
      pulseOx.startTimeInSeconds,
      "oxygen_saturation",
      pulseOx.summaryId,
    ),
  );

  return points;
}

export function normalizePulseOxSummary(pulseOx: GarminPulseOx): NormalizedDailySummary | null {
  if (pulseOx.avgSpo2 == null || !pulseOx.startTimeInSeconds) {
    return null;
  }

  return {
    date: isoDateFromCalendarDate(pulseOx.calendarDate, pulseOx.startTimeInSeconds * 1000),
    category: "recovery",
    spo2Avg: pulseOx.avgSpo2,
  };
}

export function normalizeBloodPressureDataPoints(
  bloodPressure: GarminBloodPressure,
): NormalizedDataPoint[] {
  const measurementSeconds =
    bloodPressure.measurementTimestampGMT ?? bloodPressure.startTimeInSeconds;
  if (!measurementSeconds) {
    return [];
  }

  const recordedAt = measurementSeconds * 1000;
  const points: NormalizedDataPoint[] = [];

  if (bloodPressure.systolic != null) {
    points.push({
      seriesType: "blood_pressure_systolic",
      recordedAt,
      value: bloodPressure.systolic,
      externalId: bloodPressure.summaryId ? `${bloodPressure.summaryId}:systolic` : undefined,
    });
  }

  if (bloodPressure.diastolic != null) {
    points.push({
      seriesType: "blood_pressure_diastolic",
      recordedAt,
      value: bloodPressure.diastolic,
      externalId: bloodPressure.summaryId ? `${bloodPressure.summaryId}:diastolic` : undefined,
    });
  }

  return points;
}

export function normalizeUserMetricsDataPoints(
  userMetrics: GarminUserMetrics,
): NormalizedDataPoint[] {
  const recordedAt = calendarDateToMiddayTimestamp(userMetrics.calendarDate);
  if (recordedAt === null) {
    return [];
  }

  const points: NormalizedDataPoint[] = [];
  if (userMetrics.vo2Max != null) {
    points.push({
      seriesType: "vo2_max",
      recordedAt,
      value: userMetrics.vo2Max,
      externalId: userMetrics.summaryId ? `${userMetrics.summaryId}:vo2_max` : undefined,
    });
  }

  if (userMetrics.fitnessAge != null) {
    points.push({
      seriesType: "garmin_fitness_age",
      recordedAt,
      value: userMetrics.fitnessAge,
      externalId: userMetrics.summaryId ? `${userMetrics.summaryId}:fitness_age` : undefined,
    });
  }

  return points;
}

export function normalizeSkinTemperatureDataPoints(
  skinTemp: GarminSkinTemp,
): NormalizedDataPoint[] {
  if (!skinTemp.startTimeInSeconds || skinTemp.skinTemperature == null) {
    return [];
  }

  return [
    {
      seriesType: "skin_temperature",
      recordedAt: skinTemp.startTimeInSeconds * 1000,
      value: skinTemp.skinTemperature,
      externalId: skinTemp.summaryId,
    },
  ];
}

export function normalizeHealthSnapshotDataPoints(
  snapshot: GarminHealthSnapshot,
): NormalizedDataPoint[] {
  if (!snapshot.startTimeInSeconds) {
    return [];
  }

  const recordedAt = snapshot.startTimeInSeconds * 1000;
  const points: NormalizedDataPoint[] = [];

  if (snapshot.heartRate != null) {
    points.push({
      seriesType: "heart_rate",
      recordedAt,
      value: snapshot.heartRate,
      externalId: snapshot.summaryId ? `${snapshot.summaryId}:heart_rate` : undefined,
    });
  }

  if (snapshot.hrv != null) {
    points.push({
      seriesType: "heart_rate_variability_sdnn",
      recordedAt,
      value: snapshot.hrv,
      externalId: snapshot.summaryId ? `${snapshot.summaryId}:hrv` : undefined,
    });
  }

  if (snapshot.stress != null) {
    points.push({
      seriesType: "garmin_stress_level",
      recordedAt,
      value: snapshot.stress,
      externalId: snapshot.summaryId ? `${snapshot.summaryId}:stress` : undefined,
    });
  }

  if (snapshot.spo2 != null) {
    points.push({
      seriesType: "oxygen_saturation",
      recordedAt,
      value: snapshot.spo2,
      externalId: snapshot.summaryId ? `${snapshot.summaryId}:spo2` : undefined,
    });
  }

  if (snapshot.respiration != null) {
    points.push({
      seriesType: "respiratory_rate",
      recordedAt,
      value: snapshot.respiration,
      externalId: snapshot.summaryId ? `${snapshot.summaryId}:respiration` : undefined,
    });
  }

  return points;
}

export function normalizeMoveIQ(moveIQ: GarminMoveIQ): NormalizedEvent {
  const startMs = moveIQ.startTimeInSeconds * 1000;
  const durationSeconds = moveIQ.durationInSeconds ?? 0;
  const endMs = startMs + durationSeconds * 1000;
  const type = moveIQ.activityType ? `moveiq_${moveIQ.activityType.toLowerCase()}` : "moveiq";

  return {
    category: "workout",
    type,
    sourceName: "Garmin",
    durationSeconds,
    startDatetime: startMs,
    endDatetime: endMs,
    externalId: moveIQ.summaryId
      ? `garmin-moveiq-${moveIQ.summaryId}`
      : `garmin-moveiq-${moveIQ.startTimeInSeconds}-${type}`,
  };
}

// ---------------------------------------------------------------------------
// Normalization — Menstrual Cycle Tracking (Women's Health)
// ---------------------------------------------------------------------------

export interface NormalizedMCT {
  externalId: string;
  periodStartDate: string;
  dayInCycle?: number;
  cycleLength?: number;
  predictedCycleLength?: number;
  periodLength?: number;
  currentPhase?: number;
  currentPhaseType?: string;
  lengthOfCurrentPhase?: number;
  daysUntilNextPhase?: number;
  isPredictedCycle?: boolean;
  fertileWindowStart?: number;
  lengthOfFertileWindow?: number;
  lastUpdatedAt?: number;
  isPregnant?: boolean;
  pregnancyDueDate?: string;
  pregnancyOriginalDueDate?: string;
  pregnancyCycleStartDate?: string;
  pregnancyTitle?: string;
  numberOfBabies?: string;
}

export function normalizeMCT(mct: GarminMCTSummary): NormalizedMCT {
  const periodStartDate =
    mct.periodStartDateStr ??
    (mct.startTimeInSeconds
      ? new Date(mct.startTimeInSeconds * 1000).toISOString().split("T")[0]
      : new Date().toISOString().split("T")[0]);

  return {
    externalId: `garmin-mct-${mct.summaryId}`,
    periodStartDate,
    dayInCycle: mct.dayInCycle,
    cycleLength: mct.cycleLength,
    predictedCycleLength: mct.predictedCycleLength,
    periodLength: mct.periodLength,
    currentPhase: mct.currentPhase,
    currentPhaseType: mct.currentPhaseType,
    lengthOfCurrentPhase: mct.lengthOfCurrentPhase,
    daysUntilNextPhase: mct.daysUntilNextPhase,
    isPredictedCycle: mct.isPredictedCycle,
    fertileWindowStart: mct.fertileWindowStart,
    lengthOfFertileWindow: mct.lengthOfFertileWindow,
    lastUpdatedAt: mct.lastUpdatedAt ? mct.lastUpdatedAt * 1000 : undefined,
    isPregnant: mct.isPregnant,
    pregnancyDueDate: mct.pregnancyDueDate,
    pregnancyOriginalDueDate: mct.pregnancyOriginalDueDate,
    pregnancyCycleStartDate: mct.pregnancyCycleStartDate,
    pregnancyTitle: mct.pregnancyTitle,
    numberOfBabies: mct.numberOfBabies,
  };
}

// ---------------------------------------------------------------------------
// User info
// ---------------------------------------------------------------------------

export async function getGarminUserInfo(
  accessToken: string,
  _tokenResponse?: unknown,
  _appUserId?: string,
  _credentials?: ProviderCredentials,
): Promise<ProviderUserInfo> {
  try {
    const data = await makeAuthenticatedRequest<{ userId: string }>(
      API_BASE,
      "/wellness-api/rest/user/id",
      accessToken,
    );
    return {
      providerUserId: data.userId ?? null,
      username: null,
    };
  } catch {
    return { providerUserId: null, username: null };
  }
}

export const garminProvider: ProviderAdapter = {
  name: "garmin",
  oauthConfig: garminOAuthConfig,
  getUserInfo: getGarminUserInfo,
  fetchEvents: fetchGarminWorkouts,
};

// ---------------------------------------------------------------------------
// Garmin is push-based — no fetchWorkouts (data comes via webhooks)
// ---------------------------------------------------------------------------

/**
 * Garmin does not support pull-based data fetching.
 * Data is pushed via webhooks. This function exists to satisfy the
 * ProviderDefinition interface but returns an empty array.
 *
 * Use the backfill API to trigger historical data push.
 */
export async function fetchGarminWorkouts(
  _accessToken: string,
  _startDate: number,
  _endDate: number,
  _credentials?: ProviderCredentials,
): Promise<NormalizedEvent[]> {
  // Garmin is push-only — data comes via webhooks, not pull requests.
  // To get historical data, call the backfill API which triggers Garmin
  // to push data to your webhook endpoints.
  return [];
}

// ---------------------------------------------------------------------------
// Backfill trigger
// ---------------------------------------------------------------------------

/**
 * Trigger a Garmin backfill request. Garmin will asynchronously push
 * historical data to your webhook endpoints.
 */
export async function triggerBackfill(
  accessToken: string,
  dataType: string,
  startTimeSeconds: number,
  endTimeSeconds: number,
): Promise<void> {
  const validTypes = [
    "activities",
    "activityDetails",
    "dailies",
    "epochs",
    "sleeps",
    "bodyComps",
    "hrv",
    "stressDetails",
    "respiration",
    "pulseOx",
    "bloodPressures",
    "userMetrics",
    "skinTemp",
    "healthSnapshot",
    "moveiq",
    "mct",
  ];
  if (!validTypes.includes(dataType)) {
    throw new Error(`Invalid backfill data type: ${dataType}`);
  }

  await makeAuthenticatedRequest(API_BASE, `/wellness-api/rest/backfill/${dataType}`, accessToken, {
    params: {
      summaryStartTimeInSeconds: String(startTimeSeconds),
      summaryEndTimeInSeconds: String(endTimeSeconds),
    },
  });
}
