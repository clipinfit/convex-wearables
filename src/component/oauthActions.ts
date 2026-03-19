/**
 * OAuth flow Convex actions.
 *
 * Actions (not mutations) because they make external HTTP calls to
 * provider token endpoints and APIs.
 */

import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateRandomString,
  refreshAccessToken,
} from "./providers/oauth";
import { getProvider } from "./providers/registry";
import type { ProviderCredentials } from "./providers/types";
import { providerName } from "./schema";

// ---------------------------------------------------------------------------
// Generate authorization URL
// ---------------------------------------------------------------------------

/**
 * Generate an OAuth authorization URL for a provider.
 *
 * Stores the state token in the oauthStates table and returns the URL
 * the client should redirect the user to.
 */
export const generateAuthUrl = action({
  args: {
    userId: v.string(),
    provider: providerName,
    clientId: v.string(),
    clientSecret: v.string(),
    subscriptionKey: v.optional(v.string()),
    redirectUri: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.providerSettings.upsertCredentials, {
      provider: args.provider,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      subscriptionKey: args.subscriptionKey,
    });

    const providerDef = getProvider(args.provider);
    if (!providerDef) {
      throw new Error(`Provider "${args.provider}" is not implemented`);
    }

    const credentials: ProviderCredentials = {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      subscriptionKey: args.subscriptionKey,
    };
    const config = providerDef.oauthConfig(credentials);

    // Generate state token
    const state = generateRandomString(32);

    // PKCE if the provider requires it
    let codeVerifier: string | undefined;
    let codeChallenge: string | undefined;
    if (config.usePkce) {
      codeVerifier = generateRandomString(64);
      codeChallenge = await generateCodeChallenge(codeVerifier);
    }

    // Store state in the database for validation during callback
    await ctx.runMutation(internal.oauthStates.store, {
      state,
      userId: args.userId,
      provider: args.provider,
      codeVerifier,
      redirectUri: args.redirectUri,
    });

    // Build the authorization URL
    const url = buildAuthorizationUrl({
      config,
      redirectUri: args.redirectUri,
      state,
      codeChallenge,
    });

    return url;
  },
});

// ---------------------------------------------------------------------------
// Handle OAuth callback (exchange code for tokens)
// ---------------------------------------------------------------------------

/**
 * Handle the OAuth callback. Consumes the state token, exchanges the
 * authorization code for access/refresh tokens, fetches the user's
 * provider profile, and creates/updates the connection.
 */
export const handleCallback = action({
  args: {
    state: v.string(),
    code: v.string(),
    clientId: v.string(),
    clientSecret: v.string(),
    subscriptionKey: v.optional(v.string()),
  },
  returns: v.object({
    provider: v.string(),
    userId: v.string(),
    connectionId: v.string(),
  }),
  handler: async (ctx, args) => {
    // Consume the state token
    const oauthState = await ctx.runMutation(internal.oauthStates.consume, {
      state: args.state,
    });

    if (!oauthState) {
      throw new Error("Invalid or expired OAuth state");
    }

    const providerDef = getProvider(oauthState.provider);
    if (!providerDef) {
      throw new Error(`Provider "${oauthState.provider}" is not implemented`);
    }

    await ctx.runMutation(internal.providerSettings.upsertCredentials, {
      provider: oauthState.provider,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      subscriptionKey: args.subscriptionKey,
    });

    const credentials: ProviderCredentials = {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      subscriptionKey: args.subscriptionKey,
    };
    const config = providerDef.oauthConfig(credentials);

    // Exchange code for tokens
    const tokenResponse = await exchangeCodeForTokens(
      config,
      args.code,
      oauthState.redirectUri ?? "",
      oauthState.codeVerifier,
    );

    // Fetch user info from the provider
    if (providerDef.postConnect) {
      await providerDef.postConnect(
        tokenResponse.access_token,
        tokenResponse,
        oauthState.userId,
        credentials,
      );
    }

    const userInfo = await providerDef.getUserInfo(
      tokenResponse.access_token,
      tokenResponse,
      oauthState.userId,
      credentials,
    );

    // Calculate token expiry
    const tokenExpiresAt = tokenResponse.expires_in
      ? Date.now() + tokenResponse.expires_in * 1000
      : undefined;

    // Create or update the connection
    const connectionId = await ctx.runMutation(internal.connections.createConnection, {
      userId: oauthState.userId,
      provider: oauthState.provider,
      providerUserId: userInfo.providerUserId ?? undefined,
      providerUsername: userInfo.username ?? undefined,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      tokenExpiresAt,
      scope: tokenResponse.scope,
    });

    // Create a data source for this connection
    await ctx.runMutation(api.dataSources.getOrCreate, {
      userId: oauthState.userId,
      provider: oauthState.provider,
      connectionId,
      source: oauthState.provider,
    });

    return {
      provider: oauthState.provider,
      userId: oauthState.userId,
      connectionId: String(connectionId),
    };
  },
});

/**
 * Ensure a connection has a valid (non-expired) access token.
 * If expired, refreshes the token and updates the connection.
 * Returns the valid access token.
 */
export const ensureValidToken = internalAction({
  args: {
    connectionId: v.id("connections"),
    provider: providerName,
    accessToken: v.string(),
    refreshToken: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    clientId: v.string(),
    clientSecret: v.string(),
    subscriptionKey: v.optional(v.string()),
  },
  returns: v.string(), // valid access token
  handler: async (ctx, args) => {
    // Check if token is still valid (with 5-minute buffer)
    const bufferMs = 5 * 60 * 1000;
    if (args.tokenExpiresAt && args.tokenExpiresAt - bufferMs > Date.now()) {
      return args.accessToken;
    }

    // Token is expired or about to expire — refresh it
    if (!args.refreshToken) {
      throw new Error(
        `Token expired for ${args.provider} connection and no refresh token available`,
      );
    }

    const providerDef = getProvider(args.provider);
    if (!providerDef) {
      throw new Error(`Provider "${args.provider}" is not implemented`);
    }

    const credentials: ProviderCredentials = {
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      subscriptionKey: args.subscriptionKey,
    };
    const config = providerDef.oauthConfig(credentials);
    const tokenResponse = await refreshAccessToken(config, args.refreshToken);

    const newExpiresAt = tokenResponse.expires_in
      ? Date.now() + tokenResponse.expires_in * 1000
      : undefined;

    // Update the connection with new tokens
    await ctx.runMutation(internal.connections.updateTokens, {
      connectionId: args.connectionId,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? args.refreshToken,
      tokenExpiresAt: newExpiresAt,
    });

    return tokenResponse.access_token;
  },
});
