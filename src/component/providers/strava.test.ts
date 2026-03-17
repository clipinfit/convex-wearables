/**
 * Tests for Strava provider normalization logic.
 *
 * These tests verify the pure normalization functions without hitting
 * the Strava API (no network calls).
 */

import { describe, expect, it } from "vitest";
import { normalizeStravaActivity } from "./strava";

// ---------------------------------------------------------------------------
// Factory helper — builds a minimal valid Strava activity
// ---------------------------------------------------------------------------

function makeActivity(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    name: "Morning Run",
    type: "Run",
    sport_type: "Run",
    start_date: "2026-03-15T07:30:00Z",
    elapsed_time: 1800, // 30 minutes
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Strava normalizeActivity", () => {
  it("normalizes a basic running activity", () => {
    const event = normalizeStravaActivity(makeActivity());

    expect(event.category).toBe("workout");
    expect(event.type).toBe("running");
    expect(event.externalId).toBe("strava-12345");
    expect(event.durationSeconds).toBe(1800);
    expect(event.sourceName).toBe("Strava");
  });

  it("calculates start and end timestamps correctly", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        start_date: "2026-03-15T10:00:00Z",
        elapsed_time: 3600, // 1 hour
      }),
    );

    const expectedStart = new Date("2026-03-15T10:00:00Z").getTime();
    expect(event.startDatetime).toBe(expectedStart);
    expect(event.endDatetime).toBe(expectedStart + 3600 * 1000);
  });

  it("maps sport_type to unified workout type", () => {
    const cases: [string, string, string][] = [
      ["Ride", "Ride", "cycling"],
      ["MountainBikeRide", "Ride", "mountain_biking"],
      ["Swim", "Swim", "swimming"],
      ["Hike", "Hike", "hiking"],
      ["WeightTraining", "WeightTraining", "strength_training"],
      ["Yoga", "Yoga", "yoga"],
      ["AlpineSki", "AlpineSki", "alpine_skiing"],
      ["Rowing", "Rowing", "rowing"],
      ["VirtualRide", "Ride", "indoor_cycling"],
      ["TrailRun", "Run", "trail_running"],
      ["Pickleball", "Pickleball", "pickleball"],
    ];

    for (const [sportType, activityType, expected] of cases) {
      const event = normalizeStravaActivity(
        makeActivity({ sport_type: sportType, type: activityType }),
      );
      expect(event.type).toBe(expected);
    }
  });

  it("falls back to activity type when sport_type is unknown", () => {
    const event = normalizeStravaActivity(makeActivity({ sport_type: "SomeNewType", type: "Run" }));
    expect(event.type).toBe("running");
  });

  it("returns 'other' for completely unknown types", () => {
    const event = normalizeStravaActivity(
      makeActivity({ sport_type: "SomeNewType", type: "SomeOtherType" }),
    );
    expect(event.type).toBe("other");
  });

  it("includes heart rate data when available", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        average_heartrate: 145,
        max_heartrate: 172,
      }),
    );

    expect(event.heartRateAvg).toBe(145);
    expect(event.heartRateMax).toBe(172);
  });

  it("includes distance and speed data", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        distance: 10000, // 10km in meters
        average_speed: 3.5, // m/s
        max_speed: 4.2,
      }),
    );

    expect(event.distance).toBe(10000);
    expect(event.averageSpeed).toBe(3.5);
    expect(event.maxSpeed).toBe(4.2);
  });

  it("includes elevation data", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        total_elevation_gain: 250,
        elev_high: 1200,
        elev_low: 950,
      }),
    );

    expect(event.totalElevationGain).toBe(250);
    expect(event.elevHigh).toBe(1200);
    expect(event.elevLow).toBe(950);
  });

  it("includes power data", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        average_watts: 220,
        max_watts: 450,
      }),
    );

    expect(event.averageWatts).toBe(220);
    expect(event.maxWatts).toBe(450);
  });

  it("prefers calories over kilojoules for energy", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        calories: 500,
        kilojoules: 2000,
      }),
    );

    expect(event.energyBurned).toBe(500);
  });

  it("converts kilojoules to kcal when calories not available", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        kilojoules: 1000,
      }),
    );

    // 1000 * 0.239 = 239
    expect(event.energyBurned).toBeCloseTo(239, 0);
  });

  it("includes moving time", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        moving_time: 1500,
      }),
    );

    expect(event.movingTimeSeconds).toBe(1500);
  });

  it("uses device_name as sourceName when available", () => {
    const event = normalizeStravaActivity(
      makeActivity({
        device_name: "Garmin Edge 1040",
      }),
    );

    expect(event.sourceName).toBe("Garmin Edge 1040");
    expect(event.deviceModel).toBe("Garmin Edge 1040");
  });

  it("omits optional fields when not present in activity", () => {
    const event = normalizeStravaActivity(makeActivity());

    expect(event.heartRateAvg).toBeUndefined();
    expect(event.heartRateMax).toBeUndefined();
    expect(event.distance).toBeUndefined();
    expect(event.energyBurned).toBeUndefined();
    expect(event.averageWatts).toBeUndefined();
    expect(event.deviceModel).toBeUndefined();
  });
});
