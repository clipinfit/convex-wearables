/**
 * Shared types for @clipin/convex-wearables.
 *
 * These types are used by both the component internals and the host app.
 */

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export type ProviderName =
  | "garmin"
  | "suunto"
  | "polar"
  | "whoop"
  | "strava"
  | "apple"
  | "samsung"
  | "google";

export type ConnectionStatus =
  | "active"
  | "inactive"
  | "revoked"
  | "expired"
  | "error";

export type EventCategory = "workout" | "sleep";

export type SyncJobStatus = "pending" | "running" | "completed" | "failed";

// ---------------------------------------------------------------------------
// Provider configuration (passed by app)
// ---------------------------------------------------------------------------

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
  /** Suunto requires an additional subscription key. */
  subscriptionKey?: string;
}

export interface WearablesConfig {
  providers: Partial<Record<ProviderName, ProviderCredentials>>;
  /**
   * Optional function reference called when new data is synced.
   * The host app can use this to trigger downstream processing.
   */
  onDataSynced?: unknown; // FunctionReference — typed loosely to avoid coupling
}

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

export interface Connection {
  _id: string;
  userId: string;
  provider: ProviderName;
  providerUserId?: string;
  providerUsername?: string;
  status: ConnectionStatus;
  lastSyncedAt?: number;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface WorkoutEvent {
  _id: string;
  userId: string;
  category: "workout";
  type?: string;
  sourceName?: string;
  durationSeconds?: number;
  startDatetime: number;
  endDatetime?: number;
  externalId?: string;
  // Workout details
  heartRateMin?: number;
  heartRateMax?: number;
  heartRateAvg?: number;
  energyBurned?: number;
  distance?: number;
  stepsCount?: number;
  maxSpeed?: number;
  maxWatts?: number;
  movingTimeSeconds?: number;
  totalElevationGain?: number;
  averageSpeed?: number;
  averageWatts?: number;
  elevHigh?: number;
  elevLow?: number;
}

export interface SleepStage {
  stage: string;
  startTime: number;
  endTime: number;
}

export interface SleepEvent {
  _id: string;
  userId: string;
  category: "sleep";
  type?: string;
  sourceName?: string;
  durationSeconds?: number;
  startDatetime: number;
  endDatetime?: number;
  externalId?: string;
  // Sleep details
  sleepTotalDurationMinutes?: number;
  sleepTimeInBedMinutes?: number;
  sleepEfficiencyScore?: number;
  sleepDeepMinutes?: number;
  sleepRemMinutes?: number;
  sleepLightMinutes?: number;
  sleepAwakeMinutes?: number;
  isNap?: boolean;
  sleepStages?: SleepStage[];
}

export type HealthEvent = WorkoutEvent | SleepEvent;

// ---------------------------------------------------------------------------
// Data point types
// ---------------------------------------------------------------------------

export interface DataPoint {
  timestamp: number;
  value: number;
}

export interface TimeSeriesPage {
  points: DataPoint[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Events page
// ---------------------------------------------------------------------------

export interface EventsPage {
  events: HealthEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Summary types
// ---------------------------------------------------------------------------

export interface DailySummary {
  _id: string;
  userId: string;
  date: string;
  category: string;
  // Activity
  totalSteps?: number;
  totalCalories?: number;
  activeCalories?: number;
  activeMinutes?: number;
  totalDistance?: number;
  floorsClimbed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  // Sleep
  sleepDurationMinutes?: number;
  sleepEfficiency?: number;
  deepSleepMinutes?: number;
  remSleepMinutes?: number;
  lightSleepMinutes?: number;
  awakeDuringMinutes?: number;
  timeInBedMinutes?: number;
  // Recovery
  hrvAvg?: number;
  hrvRmssd?: number;
  restingHeartRate?: number;
  recoveryScore?: number;
  // Body
  weight?: number;
  bodyFatPercentage?: number;
  bodyMassIndex?: number;
  leanBodyMass?: number;
  bodyTemperature?: number;
  // Other
  avgStressLevel?: number;
  bodyBattery?: number;
  spo2Avg?: number;
}

export interface AggregateStats {
  sum: number;
  count: number;
  avg: number;
  min: number | null;
  max: number | null;
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

export interface SyncJob {
  _id: string;
  userId: string;
  provider?: ProviderName;
  status: SyncJobStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  recordsProcessed?: number;
}

export interface SyncStatus {
  provider: ProviderName;
  connectionStatus: ConnectionStatus;
  lastSyncedAt?: number;
  syncJobStatus: SyncJobStatus | null;
  syncJobError: string | null;
}

// ---------------------------------------------------------------------------
// Series type definitions — all 48 pre-defined metric types
// ---------------------------------------------------------------------------

export const SERIES_TYPES = {
  // Heart & Cardiovascular
  heart_rate: { id: 1, unit: "bpm" },
  resting_heart_rate: { id: 2, unit: "bpm" },
  heart_rate_variability_sdnn: { id: 3, unit: "ms" },
  heart_rate_recovery_one_minute: { id: 4, unit: "bpm" },
  walking_heart_rate_average: { id: 5, unit: "bpm" },
  recovery_score: { id: 6, unit: "score" },
  heart_rate_variability_rmssd: { id: 7, unit: "ms" },

  // Blood & Respiratory
  oxygen_saturation: { id: 20, unit: "percent" },
  blood_glucose: { id: 21, unit: "mg_dl" },
  blood_pressure_systolic: { id: 22, unit: "mmHg" },
  blood_pressure_diastolic: { id: 23, unit: "mmHg" },
  respiratory_rate: { id: 24, unit: "brpm" },
  sleeping_breathing_disturbances: { id: 25, unit: "count" },
  blood_alcohol_content: { id: 26, unit: "mg_dl" },
  peripheral_perfusion_index: { id: 27, unit: "score" },
  forced_vital_capacity: { id: 28, unit: "liters" },
  forced_expiratory_volume_1: { id: 29, unit: "liters" },
  peak_expiratory_flow_rate: { id: 30, unit: "liters" },

  // Body Composition
  height: { id: 40, unit: "cm" },
  weight: { id: 41, unit: "kg" },
  body_fat_percentage: { id: 42, unit: "percent" },
  body_mass_index: { id: 43, unit: "kg_m2" },
  lean_body_mass: { id: 44, unit: "kg" },
  body_temperature: { id: 45, unit: "celsius" },
  skin_temperature: { id: 46, unit: "celsius" },
  waist_circumference: { id: 47, unit: "cm" },
  body_fat_mass: { id: 48, unit: "kg" },
  skeletal_muscle_mass: { id: 49, unit: "kg" },

  // Fitness
  vo2_max: { id: 60, unit: "ml_kg_min" },
  six_minute_walk_test_distance: { id: 61, unit: "meters" },

  // Activity — Basic
  steps: { id: 80, unit: "count" },
  energy: { id: 81, unit: "kcal" },
  basal_energy: { id: 82, unit: "kcal" },
  stand_time: { id: 83, unit: "minutes" },
  exercise_time: { id: 84, unit: "minutes" },
  physical_effort: { id: 85, unit: "score" },
  flights_climbed: { id: 86, unit: "count" },
  average_met: { id: 87, unit: "met" },

  // Activity — Distance
  distance_walking_running: { id: 100, unit: "meters" },
  distance_cycling: { id: 101, unit: "meters" },
  distance_swimming: { id: 102, unit: "meters" },
  distance_downhill_snow_sports: { id: 103, unit: "meters" },
  distance_other: { id: 104, unit: "meters" },

  // Activity — Walking
  walking_step_length: { id: 120, unit: "cm" },
  walking_speed: { id: 121, unit: "m_per_s" },
  walking_double_support_percentage: { id: 122, unit: "percent" },
  walking_asymmetry_percentage: { id: 123, unit: "percent" },
  walking_steadiness: { id: 124, unit: "percent" },
  stair_descent_speed: { id: 125, unit: "m_per_s" },
  stair_ascent_speed: { id: 126, unit: "m_per_s" },

  // Activity — Running
  running_power: { id: 140, unit: "watts" },
  running_speed: { id: 141, unit: "m_per_s" },
  running_vertical_oscillation: { id: 142, unit: "cm" },
  running_ground_contact_time: { id: 143, unit: "ms" },
  running_stride_length: { id: 144, unit: "cm" },

  // Activity — Swimming
  swimming_stroke_count: { id: 160, unit: "count" },
  underwater_depth: { id: 161, unit: "meters" },

  // Activity — Generic
  cadence: { id: 180, unit: "rpm" },
  power: { id: 181, unit: "watts" },
  speed: { id: 182, unit: "m_per_s" },
  workout_effort_score: { id: 183, unit: "score" },
  estimated_workout_effort_score: { id: 184, unit: "score" },

  // Environmental
  environmental_audio_exposure: { id: 200, unit: "dB" },
  headphone_audio_exposure: { id: 201, unit: "dB" },
  environmental_sound_reduction: { id: 202, unit: "dB" },
  time_in_daylight: { id: 203, unit: "minutes" },
  water_temperature: { id: 204, unit: "celsius" },
  uv_exposure: { id: 205, unit: "count" },
  inhaler_usage: { id: 206, unit: "count" },
  weather_temperature: { id: 207, unit: "celsius" },
  weather_humidity: { id: 208, unit: "percent" },

  // Garmin-Specific
  garmin_stress_level: { id: 220, unit: "score" },
  garmin_skin_temperature: { id: 221, unit: "celsius" },
  garmin_fitness_age: { id: 222, unit: "years" },
  garmin_body_battery: { id: 223, unit: "percent" },

  // Other
  electrodermal_activity: { id: 500, unit: "count" },
  push_count: { id: 501, unit: "count" },
  atrial_fibrillation_burden: { id: 502, unit: "count" },
  insulin_delivery: { id: 503, unit: "count" },
  number_of_times_fallen: { id: 504, unit: "count" },
  number_of_alcoholic_beverages: { id: 505, unit: "count" },
  nike_fuel: { id: 506, unit: "count" },
  hydration: { id: 507, unit: "mL" },
} as const;

export type SeriesType = keyof typeof SERIES_TYPES;
