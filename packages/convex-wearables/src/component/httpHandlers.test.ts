import { describe, expect, it } from "vitest";
import { isValidStravaVerifyToken } from "./httpHandlers";

describe("Strava webhook verification", () => {
  it("accepts only the configured verification token", () => {
    expect(isValidStravaVerifyToken("expected-token", "expected-token")).toBe(true);
    expect(isValidStravaVerifyToken("wrong-token", "expected-token")).toBe(false);
  });

  it("fails closed when either token is missing", () => {
    expect(isValidStravaVerifyToken(null, "expected-token")).toBe(false);
    expect(isValidStravaVerifyToken("provided-token", undefined)).toBe(false);
  });
});
