import { afterEach, describe, expect, it, vi } from "vitest";
import { polarProvider } from "./polar";
import { suuntoOAuthConfig, suuntoProvider } from "./suunto";
import { whoopProvider } from "./whoop";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchSequence(responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function makeJwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${encoded}.signature`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("polarProvider", () => {
  it("builds OAuth config and derives the provider user id from the token response", async () => {
    const config = polarProvider.oauthConfig({
      clientId: "polar-client",
      clientSecret: "polar-secret",
    });

    expect(config.endpoints.authorizeUrl).toBe("https://flow.polar.com/oauth2/authorization");
    expect(config.authMethod).toBe("basic");
    expect(config.defaultScope).toBe("accesslink.read_all");

    const user = await polarProvider.getUserInfo("token", {
      access_token: "token",
      x_user_id: 42,
    });
    expect(user).toEqual({
      providerUserId: "42",
      username: null,
    });
  });

  it("fetches and normalizes Polar workout events", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse([
        {
          id: "exercise-1",
          device: "Polar Vantage",
          sport: "RUNNING",
          detailed_sport_info: "RUNNING_TRAIL",
          start_time: "2026-03-15T10:00:00Z",
          start_time_utc_offset: 60,
          duration: "PT45M",
          calories: 450,
          distance: 9500,
          heart_rate: {
            average: 148,
            maximum: 176,
          },
        },
      ]),
    ]);

    const events = await polarProvider.fetchEvents!(
      "polar-token",
      Date.parse("2026-03-15T00:00:00Z"),
      Date.parse("2026-03-16T00:00:00Z"),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      category: "workout",
      type: "trail_running",
      sourceName: "Polar Vantage",
      externalId: "polar-exercise-1",
      durationSeconds: 2700,
      energyBurned: 450,
      distance: 9500,
      heartRateAvg: 148,
      heartRateMax: 176,
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(requestUrl.pathname).toBe("/v3/exercises");
    expect(requestUrl.search).toBe("");
  });

  it("registers the Polar member after connect", async () => {
    const fetchMock = mockFetchSequence([jsonResponse({})]);

    await polarProvider.postConnect!("polar-token", { access_token: "polar-token" }, "app-user-1");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://www.polaraccesslink.com/v3/users");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ "member-id": "app-user-1" }));
  });
});

describe("whoopProvider", () => {
  it("fetches and normalizes workout and sleep events", async () => {
    mockFetchSequence([
      jsonResponse({
        records: [
          {
            id: "workout-1",
            start: "2026-03-15T10:00:00Z",
            end: "2026-03-15T11:00:00Z",
            sport_name: "running",
            score_state: "SCORED",
            score: {
              average_heart_rate: 142,
              max_heart_rate: 173,
              kilojoule: 1000,
              distance_meter: 10200,
              altitude_gain_meter: 240,
            },
          },
        ],
      }),
      jsonResponse({
        records: [
          {
            id: "sleep-1",
            start: "2026-03-15T23:00:00Z",
            end: "2026-03-16T07:00:00Z",
            score_state: "SCORED",
            nap: false,
            score: {
              sleep_efficiency_percentage: 91,
              stage_summary: {
                total_in_bed_time_milli: 8 * 60 * 60 * 1000,
                total_awake_time_milli: 30 * 60 * 1000,
                total_light_sleep_time_milli: 4 * 60 * 60 * 1000,
                total_slow_wave_sleep_time_milli: 2 * 60 * 60 * 1000,
                total_rem_sleep_time_milli: 90 * 60 * 1000,
              },
            },
          },
        ],
      }),
    ]);

    const events = await whoopProvider.fetchEvents!(
      "whoop-token",
      Date.parse("2026-03-15T00:00:00Z"),
      Date.parse("2026-03-17T00:00:00Z"),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      category: "workout",
      type: "running",
      source: "whoop",
      externalId: "whoop-workout-workout-1",
      movingTimeSeconds: 3600,
    });
    expect(events[1]).toMatchObject({
      category: "sleep",
      source: "whoop",
      externalId: "whoop-sleep-sleep-1",
      sleepTotalDurationMinutes: 450,
      sleepTimeInBedMinutes: 480,
      sleepAwakeMinutes: 30,
      sleepDeepMinutes: 120,
      sleepLightMinutes: 240,
      sleepRemMinutes: 90,
    });
  });

  it("fetches recovery and body-measurement data points", async () => {
    mockFetchSequence([
      jsonResponse({
        records: [
          {
            created_at: "2026-03-16T08:00:00Z",
            score_state: "SCORED",
            score: {
              recovery_score: 77,
              resting_heart_rate: 51,
              hrv_rmssd_milli: 64,
              spo2_percentage: 98,
              skin_temp_celsius: 36.7,
            },
          },
        ],
      }),
      jsonResponse({
        height_meter: 1.82,
        weight_kilogram: 75,
      }),
    ]);

    const points = await whoopProvider.fetchDataPoints!(
      "whoop-token",
      Date.parse("2026-03-15T00:00:00Z"),
      Date.parse("2026-03-17T00:00:00Z"),
    );

    expect(points.map((point) => point.seriesType)).toEqual([
      "recovery_score",
      "resting_heart_rate",
      "heart_rate_variability_rmssd",
      "oxygen_saturation",
      "skin_temperature",
      "height",
      "weight",
    ]);
    expect(points[5]).toMatchObject({
      seriesType: "height",
      value: 182,
    });
    expect(points[6]).toMatchObject({
      seriesType: "weight",
      value: 75,
    });
  });
});

describe("suuntoProvider", () => {
  it("builds OAuth config and decodes user info from the JWT access token", async () => {
    const config = suuntoOAuthConfig({
      clientId: "suunto-client",
      clientSecret: "suunto-secret",
      subscriptionKey: "sub-key",
    });

    expect(config.endpoints.authorizeUrl).toBe("https://cloudapi-oauth.suunto.com/oauth/authorize");
    expect(config.defaultHeaders).toEqual({
      "Ocp-Apim-Subscription-Key": "sub-key",
    });

    const user = await suuntoProvider.getUserInfo(
      makeJwt({
        sub: "suunto-user",
        user: "denis",
      }),
    );
    expect(user).toEqual({
      providerUserId: "suunto-user",
      username: "denis",
    });
  });

  it("fetches Suunto events and data points with the subscription key header", async () => {
    const fetchMock = mockFetchSequence([
      jsonResponse({
        payload: [
          {
            workoutId: 123,
            activityId: 1,
            startTime: Date.parse("2026-03-15T09:00:00Z"),
            stopTime: Date.parse("2026-03-15T10:00:00Z"),
            totalTime: 3600,
            totalDistance: 10000,
            stepCount: 1200,
            energyConsumption: 500,
            avgSpeed: 3,
            maxSpeed: 4,
            totalAscent: 150,
            maxAltitude: 800,
            minAltitude: 650,
            avgPower: 210,
            maxPower: 420,
            gear: {
              displayName: "Suunto Race S",
              name: "Race S",
              swVersion: "2.39.44",
            },
            hrdata: {
              avg: 149,
              hrmax: 181,
              min: 92,
            },
          },
        ],
      }),
      jsonResponse([
        {
          timestamp: "2026-03-16T07:00:00Z",
          entryData: {
            BedtimeStart: "2026-03-15T23:00:00Z",
            BedtimeEnd: "2026-03-16T07:00:00Z",
            Duration: 28800,
            DeepSleepDuration: 7200,
            LightSleepDuration: 14400,
            REMSleepDuration: 5400,
            SleepQualityScore: 84,
            HRAvg: 48,
            HRMin: 41,
            SleepId: 55,
          },
        },
      ]),
      jsonResponse([
        {
          timestamp: "2026-03-16T08:00:00Z",
          entryData: { Balance: 0.82 },
        },
      ]),
      jsonResponse([
        {
          timestamp: "2026-03-16T08:00:00Z",
          entryData: {
            HR: 65,
            StepCount: 120,
            SpO2: 0.98,
            EnergyConsumption: 4184,
            HRV: 42,
          },
        },
      ]),
      jsonResponse([
        {
          Name: "stepcount",
          Sources: [
            {
              Samples: [{ TimeISO8601: "2026-03-16T00:00:00Z", Value: 10000 }],
            },
          ],
        },
        {
          Name: "energyconsumption",
          Sources: [
            {
              Samples: [{ TimeISO8601: "2026-03-16T00:00:00Z", Value: 8368 }],
            },
          ],
        },
      ]),
    ]);

    const credentials = {
      clientId: "suunto-client",
      clientSecret: "suunto-secret",
      subscriptionKey: "sub-key",
    };
    const startDate = Date.parse("2026-03-15T00:00:00Z");
    const endDate = Date.parse("2026-03-17T00:00:00Z");

    const events = await suuntoProvider.fetchEvents!(
      "suunto-token",
      startDate,
      endDate,
      credentials,
    );
    const points = await suuntoProvider.fetchDataPoints!(
      "suunto-token",
      startDate,
      endDate,
      credentials,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      category: "workout",
      type: "running",
      source: "suunto",
      externalId: "suunto-workout-123",
      softwareVersion: "2.39.44",
    });
    expect(events[1]).toMatchObject({
      category: "sleep",
      source: "suunto",
      externalId: "suunto-sleep-55",
      sleepTotalDurationMinutes: 450,
      sleepTimeInBedMinutes: 480,
      sleepAwakeMinutes: 30,
      heartRateAvg: 48,
      heartRateMin: 41,
    });

    expect(points.map((point) => point.seriesType)).toEqual([
      "recovery_score",
      "heart_rate",
      "steps",
      "oxygen_saturation",
      "energy",
      "heart_rate_variability_rmssd",
      "steps",
      "energy",
    ]);

    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(firstHeaders).toMatchObject({
      "Ocp-Apim-Subscription-Key": "sub-key",
    });
  });
});
