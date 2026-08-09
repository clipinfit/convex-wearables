import { describe, expect, it } from "vitest";
import {
  assertWithinFitSizeLimit,
  normalizeFitMessages,
  validateActivityFileUrl,
} from "./garminActivityFiles";
import { normalizeActivitySamples } from "./providers/garmin";

describe("Garmin workout enrichment normalization", () => {
  it("normalizes activityDetails samples into shared time series", () => {
    const points = normalizeActivitySamples({
      userId: "garmin-user",
      activityId: 42,
      samples: [
        {
          startTimeInSeconds: 1_700_000_000,
          heartRate: 150,
          speedMetersPerSecond: 3.5,
          latitudeInDegree: 41.4,
        },
      ],
    });
    expect(points).toEqual([
      expect.objectContaining({ seriesType: "heart_rate", value: 150 }),
      expect.objectContaining({ seriesType: "speed", value: 3.5 }),
      expect.objectContaining({ seriesType: "latitude", value: 41.4 }),
    ]);
  });

  it("maps FIT laps, strength sets, zones, and records without provider fields", () => {
    const normalized = normalizeFitMessages({
      laps: [
        {
          start_time: "2026-07-01T10:00:00.000Z",
          total_elapsed_time: 300,
          total_distance: 1_000,
          avg_heart_rate: 145,
        },
      ],
      sets: [
        {
          start_time: "2026-07-01T10:06:00.000Z",
          duration: 30,
          repetitions: 10,
          weight: 40,
          set_type: "active",
          category: [["bench_press"]],
        },
      ],
      time_in_zone: [
        {
          time_in_hr_zone: [[60, 120]],
          hr_zone_high_boundary: [[130, 150]],
        },
      ],
      records: [
        {
          timestamp: "2026-07-01T10:00:01.000Z",
          heart_rate: 140,
          enhanced_speed: 3.2,
          speed: 3.1,
        },
      ],
    });

    expect(normalized.segments).toEqual([
      expect.objectContaining({ kind: "lap", index: 0, distanceMeters: 1_000 }),
      expect.objectContaining({
        kind: "set",
        index: 0,
        exercise: "bench_press",
        repetitions: 10,
        weight: 40,
      }),
    ]);
    expect(normalized.zones).toEqual([
      expect.objectContaining({ kind: "heart_rate", zone: 0, seconds: 60, upperBound: 130 }),
      expect.objectContaining({
        kind: "heart_rate",
        zone: 1,
        seconds: 120,
        lowerBound: 130,
        upperBound: 150,
      }),
    ]);
    expect(normalized.samples).toEqual([
      expect.objectContaining({ seriesType: "heart_rate", value: 140 }),
      expect.objectContaining({ seriesType: "speed", value: 3.2 }),
    ]);
  });

  it("rejects unsafe callback URLs and oversized files", () => {
    expect(() =>
      validateActivityFileUrl("http://apis.garmin.com/file", ["apis.garmin.com"]),
    ).toThrow("not allowed");
    expect(() =>
      validateActivityFileUrl("https://apis.garmin.com.evil.example/file", ["apis.garmin.com"]),
    ).toThrow("not allowed");
    expect(
      validateActivityFileUrl("https://apis.garmin.com/file", ["apis.garmin.com"]).hostname,
    ).toBe("apis.garmin.com");
    expect(() => assertWithinFitSizeLimit(101, 100)).toThrow("size limit");
  });

  it("bounds segment and sample normalization", () => {
    const normalized = normalizeFitMessages({
      laps: Array.from({ length: 2_100 }, () => ({ timestamp: "2026-07-01T10:00:00Z" })),
      records: Array.from({ length: 100_100 }, (_, index) => ({
        timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        heart_rate: 120,
      })),
    });
    expect(normalized.segments).toHaveLength(500);
    expect(normalized.samples).toHaveLength(100_000);
  });
});
