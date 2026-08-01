import { describe, expect, it } from "vitest";
import { parseSdkPayloadV2 } from "./sdkPushValidation";

describe("parseSdkPayloadV2", () => {
  it("accepts valid rows and rejects one malformed row in partial mode", () => {
    const result = parseSdkPayloadV2({
      dataPoints: [
        {
          seriesType: "heart_rate",
          recordedAt: Date.parse("2026-08-01T08:00:00Z"),
          value: 62,
          externalId: "valid-heart-rate",
        },
        {
          seriesType: "heart_rate",
          recordedAt: "not-a-timestamp",
          value: 64,
          externalId: "invalid-heart-rate",
        },
      ],
    });

    expect(result).toMatchObject({
      status: "partially_accepted",
      mode: "partial",
      canPersist: true,
      counts: { received: 2, accepted: 1, rejected: 1 },
      categories: {
        events: { received: 0, accepted: 0, rejected: 0 },
        dataPoints: { received: 2, accepted: 1, rejected: 1 },
        summaries: { received: 0, accepted: 0, rejected: 0 },
      },
    });
    expect(result.payload.dataPoints).toEqual([
      expect.objectContaining({ externalId: "valid-heart-rate" }),
    ]);
    expect(result.rejections).toEqual([
      {
        category: "dataPoints",
        index: 1,
        code: "invalid_type",
        path: "recordedAt",
        message: 'Field "recordedAt" has an invalid type.',
      },
    ]);
  });

  it("prevents persistence of every row when strict validation finds an error", () => {
    const result = parseSdkPayloadV2(
      {
        summaries: [
          { date: "2026-08-01", category: "activity", totalSteps: 10_000 },
          { date: "01/08/2026", category: "activity", totalSteps: 9_000 },
        ],
      },
      "strict",
    );

    expect(result.status).toBe("rejected");
    expect(result.canPersist).toBe(false);
    expect(result.counts).toEqual({ received: 2, accepted: 1, rejected: 1 });
  });

  it("normalizes supported series aliases during parsing", () => {
    const result = parseSdkPayloadV2({
      dataPoints: [
        {
          seriesType: "CYCLING_PEDALING_CADENCE",
          recordedAt: Date.parse("2026-08-01T08:00:00Z"),
          value: 82,
        },
      ],
    });

    expect(result.status).toBe("accepted");
    expect(result.payload.dataPoints[0].seriesType).toBe("cadence");
  });

  it("returns sanitized rejection details without echoing health values", () => {
    const sensitiveValue = "private-health-value-123";
    const result = parseSdkPayloadV2({
      dataPoints: [
        {
          seriesType: "unknown-private-metric",
          recordedAt: Date.parse("2026-08-01T08:00:00Z"),
          value: sensitiveValue,
        },
      ],
    });

    const serialized = JSON.stringify(result.rejections);
    expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain("unknown-private-metric");
    expect(result.rejections[0]).toMatchObject({
      code: "invalid_type",
      path: "value",
    });
  });

  it("rejects an invalid envelope before any rows can persist", () => {
    const result = parseSdkPayloadV2({
      unexpectedCategory: [{ value: 42 }],
      events: [
        {
          category: "workout",
          startDatetime: Date.parse("2026-08-01T08:00:00Z"),
        },
      ],
    });

    expect(result.status).toBe("rejected");
    expect(result.canPersist).toBe(false);
    expect(result.counts).toEqual({ received: 1, accepted: 0, rejected: 1 });
    expect(result.rejections[0]).toMatchObject({
      category: "payload",
      code: "unknown_field",
      path: "unexpectedCategory",
    });
  });

  it("does not echo attacker-controlled unknown field names", () => {
    const privateFieldName = "private health value with spaces";
    const result = parseSdkPayloadV2({ [privateFieldName]: true });

    expect(JSON.stringify(result.rejections)).not.toContain(privateFieldName);
    expect(result.rejections[0]).toMatchObject({
      category: "payload",
      code: "unknown_field",
    });
    expect(result.rejections[0].path).toBeUndefined();
  });

  it("caps rejection samples while retaining the total rejected count", () => {
    const result = parseSdkPayloadV2({
      dataPoints: Array.from({ length: 55 }, () => ({
        recordedAt: Date.parse("2026-08-01T08:00:00Z"),
        value: 60,
      })),
    });

    expect(result.status).toBe("rejected");
    expect(result.counts).toEqual({ received: 55, accepted: 0, rejected: 55 });
    expect(result.rejections).toHaveLength(50);
    expect(result.rejectionCountTruncated).toBe(5);
  });

  it("keeps diagnostics bounded for varied malformed rows", () => {
    for (let run = 0; run < 100; run += 1) {
      const rows = Array.from({ length: run % 70 }, (_, index) => ({
        seriesType: index % 2 === 0 ? "heart_rate" : `unknown_${run}_${index}`,
        recordedAt: index % 3 === 0 ? "invalid" : Date.now() + index,
        value: index % 5 === 0 ? Number.NaN : index,
      }));
      const result = parseSdkPayloadV2({ dataPoints: rows });

      expect(result.rejections.length).toBeLessThanOrEqual(50);
      expect(result.rejectionCountTruncated).toBeGreaterThanOrEqual(0);
      expect(result.counts.received).toBe(rows.length);
    }
  });
});
