/**
 * Strava provider adapter.
 *
 * Fetches activities from Strava API and normalizes them to our event format.
 */

import { makeAuthenticatedRequest } from "./oauth";
import type {
  NormalizedEvent,
  OAuthProviderConfig,
  ProviderAdapter,
  ProviderCredentials,
  ProviderUserInfo,
} from "./types";

// ---------------------------------------------------------------------------
// OAuth config
// ---------------------------------------------------------------------------

export function stravaOAuthConfig(credentials: ProviderCredentials): OAuthProviderConfig {
  return {
    endpoints: {
      authorizeUrl: "https://www.strava.com/oauth/authorize",
      tokenUrl: "https://www.strava.com/api/v3/oauth/token",
      apiBaseUrl: "https://www.strava.com/api/v3",
    },
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    defaultScope: "activity:read_all,profile:read_all",
    usePkce: false,
    authMethod: "body",
  };
}

// ---------------------------------------------------------------------------
// Strava API types
// ---------------------------------------------------------------------------

interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string; // ISO 8601 UTC
  elapsed_time: number; // seconds
  distance?: number; // meters
  moving_time?: number;
  total_elevation_gain?: number;
  elev_high?: number;
  elev_low?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_speed?: number; // m/s
  max_speed?: number;
  average_watts?: number;
  max_watts?: number;
  kilojoules?: number;
  calories?: number;
  device_name?: string;
}

// ---------------------------------------------------------------------------
// Workout type mapping (Strava sport_type → unified type)
// ---------------------------------------------------------------------------

const WORKOUT_TYPE_MAP: Record<string, string> = {
  Run: "running",
  TrailRun: "trail_running",
  VirtualRun: "running",
  Ride: "cycling",
  MountainBikeRide: "mountain_biking",
  GravelRide: "cycling",
  EBikeRide: "e_biking",
  EMountainBikeRide: "e_biking",
  VirtualRide: "indoor_cycling",
  Swim: "swimming",
  Walk: "walking",
  Hike: "hiking",
  AlpineSki: "alpine_skiing",
  BackcountrySki: "backcountry_skiing",
  NordicSki: "cross_country_skiing",
  Snowboard: "snowboarding",
  Snowshoe: "snowshoeing",
  IceSkate: "ice_skating",
  Rowing: "rowing",
  Kayaking: "kayaking",
  Canoeing: "canoeing",
  StandUpPaddling: "stand_up_paddleboarding",
  Surfing: "surfing",
  Kitesurf: "kitesurfing",
  Windsurf: "windsurfing",
  Sail: "sailing",
  WeightTraining: "strength_training",
  Yoga: "yoga",
  Pilates: "pilates",
  Crossfit: "cardio_training",
  Elliptical: "elliptical",
  StairStepper: "stair_climbing",
  HighIntensityIntervalTraining: "cardio_training",
  Pickleball: "pickleball",
  Squash: "squash",
  Badminton: "badminton",
  TableTennis: "table_tennis",
  Tennis: "tennis",
  Soccer: "soccer",
  RockClimbing: "rock_climbing",
  Golf: "golf",
  Skateboard: "skateboarding",
  InlineSkate: "inline_skating",
  VirtualRow: "rowing_machine",
};

function getUnifiedWorkoutType(sportType: string, activityType: string): string {
  return WORKOUT_TYPE_MAP[sportType] ?? WORKOUT_TYPE_MAP[activityType] ?? "other";
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeActivity(activity: StravaActivity): NormalizedEvent {
  const startMs = new Date(activity.start_date).getTime();
  const endMs = startMs + activity.elapsed_time * 1000;

  // Energy: prefer calories, fallback to kilojoules * 0.239
  let energyBurned: number | undefined;
  if (activity.calories != null) {
    energyBurned = activity.calories;
  } else if (activity.kilojoules != null) {
    energyBurned = activity.kilojoules * 0.239;
  }

  return {
    category: "workout",
    type: getUnifiedWorkoutType(activity.sport_type, activity.type),
    sourceName: activity.device_name ?? "Strava",
    deviceModel: activity.device_name,
    durationSeconds: activity.elapsed_time,
    startDatetime: startMs,
    endDatetime: endMs,
    externalId: `strava-${activity.id}`,

    heartRateAvg: activity.average_heartrate,
    heartRateMax: activity.max_heartrate,
    energyBurned,
    distance: activity.distance,
    averageSpeed: activity.average_speed,
    maxSpeed: activity.max_speed,
    averageWatts: activity.average_watts,
    maxWatts: activity.max_watts,
    totalElevationGain: activity.total_elevation_gain,
    elevHigh: activity.elev_high,
    elevLow: activity.elev_low,
    movingTimeSeconds: activity.moving_time,
  };
}

// ---------------------------------------------------------------------------
// Fetch workouts
// ---------------------------------------------------------------------------

const API_BASE = "https://www.strava.com/api/v3";
const PER_PAGE = 200;

/**
 * Fetch all activities from Strava within a date range.
 * Uses page-based pagination, fetching up to 200 per page.
 */
export async function fetchStravaWorkouts(
  accessToken: string,
  startDate: number,
  endDate: number,
  _credentials?: ProviderCredentials,
): Promise<NormalizedEvent[]> {
  const allEvents: NormalizedEvent[] = [];
  let page = 1;

  const after = Math.floor(startDate / 1000);
  const before = Math.floor(endDate / 1000);

  while (true) {
    const activities = await makeAuthenticatedRequest<StravaActivity[]>(
      API_BASE,
      "/athlete/activities",
      accessToken,
      {
        params: {
          after: String(after),
          before: String(before),
          page: String(page),
          per_page: String(PER_PAGE),
        },
      },
    );

    for (const activity of activities) {
      try {
        allEvents.push(normalizeActivity(activity));
      } catch {
        // Skip activities that fail to normalize
        console.warn(`Failed to normalize Strava activity ${activity.id}`);
      }
    }

    // Last page when we get fewer than per_page results
    if (activities.length < PER_PAGE) break;
    page++;
  }

  return allEvents;
}

/**
 * Normalize a single Strava activity (for webhook push processing).
 */
export function normalizeStravaActivity(activityJson: StravaActivity): NormalizedEvent {
  return normalizeActivity(activityJson);
}

// ---------------------------------------------------------------------------
// Provider user info
// ---------------------------------------------------------------------------

/**
 * Fetch the authenticated athlete's profile from Strava.
 */
export async function getStravaUserInfo(
  accessToken: string,
  _tokenResponse?: unknown,
  _appUserId?: string,
  _credentials?: ProviderCredentials,
): Promise<ProviderUserInfo> {
  try {
    const athlete = await makeAuthenticatedRequest<{
      id: number;
      username?: string;
    }>(API_BASE, "/athlete", accessToken);

    return {
      providerUserId: String(athlete.id),
      username: athlete.username ?? null,
    };
  } catch {
    return { providerUserId: null, username: null };
  }
}

export const stravaProvider: ProviderAdapter = {
  name: "strava",
  oauthConfig: stravaOAuthConfig,
  getUserInfo: getStravaUserInfo,
  fetchEvents: fetchStravaWorkouts,
};
