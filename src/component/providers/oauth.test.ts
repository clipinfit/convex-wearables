/**
 * Tests for OAuth utility pure functions.
 *
 * No network calls — tests URL building, PKCE generation, and config handling.
 */

import { describe, expect, it } from "vitest";
import {
  generateRandomString,
  generateCodeChallenge,
  buildAuthorizationUrl,
} from "./oauth";
import type { OAuthProviderConfig } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<OAuthProviderConfig> = {}): OAuthProviderConfig {
  return {
    endpoints: {
      authorizeUrl: "https://provider.example.com/oauth/authorize",
      tokenUrl: "https://provider.example.com/oauth/token",
      apiBaseUrl: "https://api.provider.example.com",
    },
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    defaultScope: "read write",
    usePkce: false,
    authMethod: "body",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateRandomString", () => {
  it("generates a string of the requested length", () => {
    const s = generateRandomString(32);
    expect(s).toHaveLength(32);
  });

  it("generates different strings each time", () => {
    const a = generateRandomString(32);
    const b = generateRandomString(32);
    expect(a).not.toBe(b);
  });

  it("only contains URL-safe characters", () => {
    const s = generateRandomString(100);
    expect(s).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });
});

describe("generateCodeChallenge", () => {
  it("produces a base64url-encoded string", async () => {
    const challenge = await generateCodeChallenge("test-verifier");
    // Base64url: no +, /, or = padding
    expect(challenge).not.toMatch(/[+/=]/);
    expect(challenge.length).toBeGreaterThan(0);
  });

  it("produces consistent output for same input", async () => {
    const a = await generateCodeChallenge("same-verifier");
    const b = await generateCodeChallenge("same-verifier");
    expect(a).toBe(b);
  });

  it("produces different output for different input", async () => {
    const a = await generateCodeChallenge("verifier-1");
    const b = await generateCodeChallenge("verifier-2");
    expect(a).not.toBe(b);
  });
});

describe("buildAuthorizationUrl", () => {
  it("builds a basic authorization URL with required params", () => {
    const config = makeConfig();
    const url = buildAuthorizationUrl({
      config,
      redirectUri: "https://myapp.com/callback",
      state: "random-state-123",
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://provider.example.com");
    expect(parsed.pathname).toBe("/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://myapp.com/callback");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("read write");
    expect(parsed.searchParams.get("state")).toBe("random-state-123");
  });

  it("includes PKCE code_challenge when enabled", () => {
    const config = makeConfig({ usePkce: true });
    const url = buildAuthorizationUrl({
      config,
      redirectUri: "https://myapp.com/callback",
      state: "state-abc",
      codeChallenge: "challenge-xyz",
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE params when not enabled", () => {
    const config = makeConfig({ usePkce: false });
    const url = buildAuthorizationUrl({
      config,
      redirectUri: "https://myapp.com/callback",
      state: "state-abc",
      codeChallenge: "challenge-xyz",
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge")).toBeNull();
    expect(parsed.searchParams.get("code_challenge_method")).toBeNull();
  });

  it("includes extra authorize params", () => {
    const config = makeConfig({
      extraAuthorizeParams: {
        "Ocp-Apim-Subscription-Key": "suunto-key-123",
        prompt: "consent",
      },
    });

    const url = buildAuthorizationUrl({
      config,
      redirectUri: "https://myapp.com/callback",
      state: "state-abc",
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("Ocp-Apim-Subscription-Key")).toBe("suunto-key-123");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });
});

describe("provider-specific OAuth configs", () => {
  it("Strava config has correct endpoints", async () => {
    const { stravaOAuthConfig } = await import("./strava");
    const config = stravaOAuthConfig({
      clientId: "my-client-id",
      clientSecret: "my-secret",
    });

    expect(config.endpoints.authorizeUrl).toBe("https://www.strava.com/oauth/authorize");
    expect(config.endpoints.tokenUrl).toBe("https://www.strava.com/api/v3/oauth/token");
    expect(config.clientId).toBe("my-client-id");
    expect(config.clientSecret).toBe("my-secret");
    expect(config.usePkce).toBe(false);
    expect(config.authMethod).toBe("body");
    expect(config.defaultScope).toContain("activity:read_all");
  });

  it("Strava auth URL includes correct scope", async () => {
    const { stravaOAuthConfig } = await import("./strava");
    const config = stravaOAuthConfig({
      clientId: "cid",
      clientSecret: "csec",
    });

    const url = buildAuthorizationUrl({
      config,
      redirectUri: "https://app.com/cb",
      state: "st",
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("activity:read_all,profile:read_all");
  });
});
