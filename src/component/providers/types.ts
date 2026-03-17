/**
 * Provider-level types shared across all provider implementations.
 */

// ---------------------------------------------------------------------------
// OAuth configuration per provider
// ---------------------------------------------------------------------------

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export type AuthMethod = "body" | "basic";

export interface OAuthProviderConfig {
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret: string;
  defaultScope: string;
  usePkce: boolean;
  authMethod: AuthMethod;
  /** Extra query params on the authorize URL (e.g. Suunto subscription key). */
  extraAuthorizeParams?: Record<string, string>;
  /** Extra headers to attach to provider API requests. */
  defaultHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  x_user_id?: number;
  [key: string]: unknown;
}

export interface ProviderUserInfo {
  providerUserId: string | null;
  username: string | null;
}

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
  subscriptionKey?: string;
}

// ---------------------------------------------------------------------------
// Normalized workout / event data from providers
// ---------------------------------------------------------------------------

export interface NormalizedEvent {
  category: "workout" | "sleep";
  type?: string;
  sourceName?: string;
  deviceModel?: string;
  softwareVersion?: string;
  source?: string;
  deviceType?: string;
  originalSourceName?: string;
  durationSeconds?: number;
  startDatetime: number; // unix ms
  endDatetime?: number; // unix ms
  externalId?: string;

  // Workout fields
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

  // Sleep fields
  sleepTotalDurationMinutes?: number;
  sleepTimeInBedMinutes?: number;
  sleepEfficiencyScore?: number;
  sleepDeepMinutes?: number;
  sleepRemMinutes?: number;
  sleepLightMinutes?: number;
  sleepAwakeMinutes?: number;
  isNap?: boolean;
  sleepStages?: { stage: string; startTime: number; endTime: number }[];
}

export interface NormalizedDataPoint {
  seriesType: string;
  recordedAt: number;
  value: number;
  externalId?: string;
  deviceModel?: string;
  softwareVersion?: string;
  source?: string;
  deviceType?: string;
  originalSourceName?: string;
}

export interface NormalizedDailySummary {
  date: string;
  category: string;
  totalSteps?: number;
  totalCalories?: number;
  activeCalories?: number;
  activeMinutes?: number;
  totalDistance?: number;
  floorsClimbed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  sleepDurationMinutes?: number;
  sleepEfficiency?: number;
  deepSleepMinutes?: number;
  remSleepMinutes?: number;
  lightSleepMinutes?: number;
  awakeDuringMinutes?: number;
  timeInBedMinutes?: number;
  hrvAvg?: number;
  hrvRmssd?: number;
  restingHeartRate?: number;
  recoveryScore?: number;
  weight?: number;
  bodyFatPercentage?: number;
  bodyMassIndex?: number;
  leanBodyMass?: number;
  bodyTemperature?: number;
  avgStressLevel?: number;
  bodyBattery?: number;
  spo2Avg?: number;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface ProviderAdapter {
  name: string;
  /** Build the OAuth config from provider credentials. */
  oauthConfig(credentials: ProviderCredentials): OAuthProviderConfig;
  /** Resolve the authenticated provider user. */
  getUserInfo(
    accessToken: string,
    tokenResponse?: OAuthTokenResponse,
    appUserId?: string,
    credentials?: ProviderCredentials,
  ): Promise<ProviderUserInfo>;
  /** Optional provider-specific action after token exchange. */
  postConnect?(
    accessToken: string,
    tokenResponse: OAuthTokenResponse,
    appUserId: string,
    credentials?: ProviderCredentials,
  ): Promise<void>;
  /** Fetch provider events (workouts, sleep). */
  fetchEvents?(
    accessToken: string,
    startDate: number,
    endDate: number,
    credentials?: ProviderCredentials,
  ): Promise<NormalizedEvent[]>;
  /** Fetch time-series provider data. */
  fetchDataPoints?(
    accessToken: string,
    startDate: number,
    endDate: number,
    credentials?: ProviderCredentials,
  ): Promise<NormalizedDataPoint[]>;
  /** Fetch daily summary provider data. */
  fetchDailySummaries?(
    accessToken: string,
    startDate: number,
    endDate: number,
    credentials?: ProviderCredentials,
  ): Promise<NormalizedDailySummary[]>;
}
