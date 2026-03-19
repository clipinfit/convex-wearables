/**
 * Generic OAuth 2.0 utilities.
 * Used by provider-specific OAuth configs to build authorization URLs,
 * exchange codes for tokens, and refresh tokens.
 */

import type { OAuthProviderConfig, OAuthTokenResponse } from "./types";

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random URL-safe string for use as state or code_verifier.
 */
export function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join("");
}

/**
 * Generate a PKCE code_challenge from a code_verifier using SHA-256.
 */
export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  // Base64url encode (no padding)
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export interface AuthUrlParams {
  config: OAuthProviderConfig;
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

/**
 * Build the provider's authorization URL.
 */
export function buildAuthorizationUrl(params: AuthUrlParams): string {
  const { config, redirectUri, state, codeChallenge } = params;
  const url = new URL(config.endpoints.authorizeUrl);

  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  if (config.defaultScope) {
    url.searchParams.set("scope", config.defaultScope);
  }
  url.searchParams.set("state", state);

  if (config.usePkce && codeChallenge) {
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }

  // Extra params (e.g., Suunto subscription key)
  if (config.extraAuthorizeParams) {
    for (const [key, value] of Object.entries(config.extraAuthorizeParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// Token Exchange
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  if (config.usePkce && codeVerifier) {
    body.set("code_verifier", codeVerifier);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (config.authMethod === "basic") {
    const credentials = btoa(`${config.clientId}:${config.clientSecret}`);
    headers.Authorization = `Basic ${credentials}`;
  } else {
    // Body-based auth
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }

  const response = await fetch(config.endpoints.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return (await response.json()) as OAuthTokenResponse;
}

// ---------------------------------------------------------------------------
// Token Refresh
// ---------------------------------------------------------------------------

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (config.authMethod === "basic") {
    const credentials = btoa(`${config.clientId}:${config.clientSecret}`);
    headers.Authorization = `Basic ${credentials}`;
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }

  const response = await fetch(config.endpoints.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  return (await response.json()) as OAuthTokenResponse;
}

// ---------------------------------------------------------------------------
// Authenticated API requests (with retry)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 15_000;

/**
 * Make an authenticated request to a provider API with automatic retry on 429.
 */
export async function makeAuthenticatedRequest<T = unknown>(
  baseUrl: string,
  endpoint: string,
  accessToken: string,
  options: {
    method?: string;
    params?: Record<string, string | number>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const { method = "GET", params, body, headers: extraHeaders } = options;

  const url = new URL(endpoint, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    ...extraHeaders,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (response.status === 401) {
      throw new Error("Authorization expired — token refresh needed");
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API request failed (${response.status}): ${text}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return JSON.parse(text) as T;
    }

    return text as T;
  }

  throw new Error(`API request failed after ${MAX_RETRIES} retries (rate limited)`);
}
