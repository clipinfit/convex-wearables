/**
 * Polar provider adapter — OAuth 2.0 + workout pull flow.
 */

import type {
  OAuthProviderConfig,
  NormalizedEvent,
  OAuthTokenResponse,
  ProviderAdapter,
  ProviderCredentials,
  ProviderUserInfo,
} from "./types";
import { makeAuthenticatedRequest } from "./oauth";

const POLAR_API_BASE = "https://www.polaraccesslink.com";
const POLAR_AUTHORIZE_URL = "https://flow.polar.com/oauth2/authorization";
const POLAR_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";
const POLAR_WORKOUT_SCOPE = "accesslink.read_all";

const POLAR_WORKOUT_TYPE_MAPPINGS: Array<[string, string | null, string]> = [
  ["RUNNING", null, "running"],
  ["RUNNING", "RUNNING_ROAD", "running"],
  ["RUNNING", "RUNNING_TRAIL", "trail_running"],
  ["RUNNING", "RUNNING_TREADMILL", "treadmill"],
  ["CYCLING", null, "cycling"],
  ["CYCLING", "CYCLING_ROAD", "cycling"],
  ["CYCLING", "CYCLING_MOUNTAIN", "mountain_biking"],
  ["CYCLING", "CYCLING_INDOOR", "indoor_cycling"],
  ["OTHER", "CYCLING_MOUNTAIN_BIKE", "mountain_biking"],
  ["OTHER", "CYCLING_CYCLOCROSS", "cyclocross"],
  ["SWIMMING", null, "swimming"],
  ["SWIMMING", "SWIMMING_POOL", "pool_swimming"],
  ["SWIMMING", "SWIMMING_OPEN_WATER", "open_water_swimming"],
  ["OTHER", "AQUATICS_SWIMMING", "swimming"],
  ["WALKING", null, "walking"],
  ["OTHER", "WALKING", "walking"],
  ["OTHER", "WALKING_NORDIC", "walking"],
  ["OTHER", "HIKING", "hiking"],
  ["OTHER", "MOUNTAINEERING", "mountaineering"],
  ["OTHER", "WINTERSPORTS_CROSS_COUNTRY_SKIING", "cross_country_skiing"],
  ["OTHER", "WINTERSPORTS_ALPINE_SKIING", "alpine_skiing"],
  ["OTHER", "WINTERSPORTS_BACKCOUNTRY_SKIING", "backcountry_skiing"],
  ["OTHER", "WINTERSPORTS_DOWNHILL_SKIING", "alpine_skiing"],
  ["OTHER", "WINTERSPORTS_SNOWBOARDING", "snowboarding"],
  ["OTHER", "WINTERSPORTS_SNOWSHOEING", "snowshoeing"],
  ["OTHER", "WINTERSPORTS_ICE_SKATING", "ice_skating"],
  ["STRENGTH_TRAINING", null, "strength_training"],
  ["OTHER", "FITNESS_CARDIO", "cardio_training"],
  ["OTHER", "FITNESS_ELLIPTICAL", "elliptical"],
  ["OTHER", "FITNESS_INDOOR_ROWING", "rowing"],
  ["OTHER", "FITNESS_STAIR_CLIMBING", "stair_climbing"],
  ["OTHER", "WATERSPORTS_ROWING", "rowing"],
  ["OTHER", "WATERSPORTS_KAYAKING", "kayaking"],
  ["OTHER", "WATERSPORTS_CANOEING", "canoeing"],
  ["OTHER", "WATERSPORTS_STAND_UP_PADDLING", "stand_up_paddleboarding"],
  ["OTHER", "WATERSPORTS_SURFING", "surfing"],
  ["OTHER", "WATERSPORTS_KITESURFING", "kitesurfing"],
  ["OTHER", "WATERSPORTS_WINDSURFING", "windsurfing"],
  ["OTHER", "WATERSPORTS_SAILING", "sailing"],
  ["OTHER", "WATERSPORTS_WATERSKI", "other"],
  ["BASKETBALL", null, "basketball"],
  ["SOCCER", null, "soccer"],
  ["OTHER", "TEAMSPORTS_SOCCER", "soccer"],
  ["OTHER", "TEAMSPORTS_FOOTBALL", "football"],
  ["OTHER", "TEAMSPORTS_AMERICAN_FOOTBALL", "american_football"],
  ["OTHER", "TEAMSPORTS_BASEBALL", "baseball"],
  ["OTHER", "TEAMSPORTS_BASKETBALL", "basketball"],
  ["OTHER", "TEAMSPORTS_VOLLEYBALL", "volleyball"],
  ["OTHER", "TEAMSPORTS_HANDBALL", "handball"],
  ["OTHER", "TEAMSPORTS_RUGBY", "rugby"],
  ["OTHER", "TEAMSPORTS_HOCKEY", "hockey"],
  ["OTHER", "TEAMSPORTS_FLOORBALL", "floorball"],
  ["TENNIS", null, "tennis"],
  ["OTHER", "RACKET_SPORTS_TENNIS", "tennis"],
  ["OTHER", "RACKET_SPORTS_BADMINTON", "badminton"],
  ["OTHER", "RACKET_SPORTS_SQUASH", "squash"],
  ["OTHER", "RACKET_SPORTS_TABLE_TENNIS", "table_tennis"],
  ["OTHER", "RACKET_SPORTS_PADEL", "padel"],
  ["OTHER", "RACKET_SPORTS_PICKLEBALL", "pickleball"],
  ["OTHER", "COMBAT_SPORTS_BOXING", "boxing"],
  ["OTHER", "COMBAT_SPORTS_MARTIAL_ARTS", "martial_arts"],
  ["OTHER", "OUTDOOR_CLIMBING", "rock_climbing"],
  ["OTHER", "INDOOR_CLIMBING", "rock_climbing"],
  ["OTHER", "SPORTS_GOLF", "golf"],
  ["MOTORSPORTS", null, "motorcycling"],
  ["OTHER", "MOTORSPORTS", "motorcycling"],
  ["OTHER", "DANCE", "dance"],
  ["OTHER", "AEROBICS", "aerobics"],
  ["OTHER", null, "other"],
];

type PolarExercise = {
  id: string;
  device?: string;
  sport: string;
  detailed_sport_info?: string | null;
  start_time: string;
  start_time_utc_offset: number;
  duration: string;
  calories?: number | null;
  distance?: number | null;
  heart_rate?: {
    average?: number | null;
    maximum?: number | null;
  };
};

function resolvePolarWorkoutType(sport: string, detailed?: string | null): string {
  if (detailed) {
    const match = POLAR_WORKOUT_TYPE_MAPPINGS.find(
      ([s, detail]) => s === sport && detail === detailed,
    );
    if (match) {
      return match[2];
    }
  }
  const fallback = POLAR_WORKOUT_TYPE_MAPPINGS.find(([s, detail]) => s === sport && detail === null);
  if (fallback) {
    return fallback[2];
  }
  return "other";
}

function parsePolarDuration(duration: string): number {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = regex.exec(duration);
  if (!match) return 0;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function normalizePolarExercise(exercise: PolarExercise): NormalizedEvent {
  const durationSeconds = parsePolarDuration(exercise.duration);
  const baseStart = Date.parse(exercise.start_time);
  const offsetMs = exercise.start_time_utc_offset * 60_000;
  const startDatetime = baseStart + offsetMs;
  const endDatetime = startDatetime + durationSeconds * 1000;

  const heartRateAvg = exercise.heart_rate?.average ?? undefined;
  const heartRateMax = exercise.heart_rate?.maximum ?? undefined;

  return {
    category: "workout",
    type: resolvePolarWorkoutType(exercise.sport, exercise.detailed_sport_info),
    sourceName: exercise.device ?? "Polar",
    deviceModel: exercise.device,
    durationSeconds: durationSeconds || undefined,
    startDatetime,
    endDatetime,
    externalId: `polar-${exercise.id}`,
    heartRateAvg,
    heartRateMax,
    energyBurned: exercise.calories ?? undefined,
    distance: exercise.distance ?? undefined,
  };
}

function buildPolarOAuthConfig(credentials: ProviderCredentials): OAuthProviderConfig {
  return {
    endpoints: {
      authorizeUrl: POLAR_AUTHORIZE_URL,
      tokenUrl: POLAR_TOKEN_URL,
      apiBaseUrl: POLAR_API_BASE,
    },
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    defaultScope: POLAR_WORKOUT_SCOPE,
    usePkce: false,
    authMethod: "basic",
  };
}

async function registerMember(accessToken: string, appUserId: string): Promise<void> {
  try {
    await fetch(`${POLAR_API_BASE}/v3/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ "member-id": appUserId }),
    });
  } catch (error) {
    console.warn("Polar member registration failed", error);
  }
}

async function fetchPolarWorkouts(
  accessToken: string,
  startDate: number,
  endDate: number,
  _credentials?: ProviderCredentials,
): Promise<NormalizedEvent[]> {
  const exercises = await makeAuthenticatedRequest<PolarExercise[]>(
    POLAR_API_BASE,
    "/v3/exercises",
    accessToken,
  );

  const records = Array.isArray(exercises) ? exercises : [];
  return records
    .map(normalizePolarExercise)
    .filter(
      (event) =>
        event.startDatetime >= startDate &&
        event.startDatetime <= endDate,
    );
}

export const polarProvider: ProviderAdapter = {
  name: "polar",
  oauthConfig: buildPolarOAuthConfig,
  getUserInfo: async (_accessToken, tokenResponse) => ({
    providerUserId:
      tokenResponse?.x_user_id != null
        ? String(tokenResponse.x_user_id)
        : null,
    username: null,
  }),
  postConnect: async (accessToken, _tokenResponse, appUserId) => {
    if (appUserId) {
      await registerMember(accessToken, appUserId);
    }
  },
  fetchEvents: fetchPolarWorkouts,
};
