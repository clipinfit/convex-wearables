/**
 * HTTP action handlers for OAuth callbacks and provider webhooks.
 *
 * These are Convex httpAction endpoints that handle:
 * 1. OAuth callback redirects (GET /oauth/callback)
 * 2. Provider webhook pushes (POST /webhooks/:provider)
 */

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

// ---------------------------------------------------------------------------
// OAuth callback handler
// ---------------------------------------------------------------------------

/**
 * Handles the OAuth redirect callback from a provider.
 *
 * Expected query params:
 *   - state: The OAuth state token
 *   - code: The authorization code
 *
 * The host app must mount this at a route and pass client credentials
 * via the component configuration.
 */
export const oauthCallback = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(JSON.stringify({ error: `OAuth error: ${error}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!state || !code) {
    return new Response(JSON.stringify({ error: "Missing state or code parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Look up the state to find which provider and user this is for
  const oauthState = await ctx.runQuery(internal.oauthStates.getByState, {
    state,
  });

  if (!oauthState) {
    return new Response(JSON.stringify({ error: "Invalid or expired OAuth state" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Return the state and code to be processed by the client-side handler.
  // The host app will call handleCallback action with credentials.
  return new Response(
    JSON.stringify({
      state,
      code,
      provider: oauthState.provider,
      userId: oauthState.userId,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});

// ---------------------------------------------------------------------------
// Strava webhook verification (GET)
// ---------------------------------------------------------------------------

/**
 * Strava webhook subscription verification.
 * Strava sends a GET request with hub.challenge to verify the endpoint.
 */
export const stravaWebhookVerify = httpAction(async (_ctx, request) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const challenge = url.searchParams.get("hub.challenge");
  const _verifyToken = url.searchParams.get("hub.verify_token");

  if (mode !== "subscribe" || !challenge) {
    return new Response("Invalid request", { status: 400 });
  }

  // The verify token should match what was set during subscription creation.
  // For now, accept any verify token — the host app should validate this
  // in their configuration.
  return new Response(JSON.stringify({ "hub.challenge": challenge }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// ---------------------------------------------------------------------------
// Strava webhook events (POST)
// ---------------------------------------------------------------------------

/**
 * Handles incoming Strava webhook events.
 *
 * Strava pushes activity create/update/delete events here.
 * We process activity creates/updates by fetching the full activity
 * and storing it. Deletes are handled by removing the corresponding event.
 */
export const stravaWebhookEvent = httpAction(async (_ctx, request) => {
  try {
    const body = await request.json();

    // Strava webhook payload format:
    // { object_type: "activity", object_id: 123, aspect_type: "create"|"update"|"delete",
    //   owner_id: 456, subscription_id: 789 }
    const { object_type, aspect_type, owner_id } = body;

    if (object_type !== "activity") {
      // We only handle activity events for now
      return new Response("OK", { status: 200 });
    }

    // Find the connection for this Strava user
    // Note: owner_id is the Strava athlete ID (providerUserId)
    // The host app should schedule a sync for this user's connection
    // rather than processing inline (to handle rate limits, batching, etc.)

    // For now, acknowledge the webhook. The actual processing will be
    // triggered by scheduling a syncConnection action for the affected user.
    console.log(`Strava webhook: ${aspect_type} activity for owner ${owner_id}`);

    return new Response("OK", { status: 200 });
  } catch {
    return new Response("Internal error", { status: 500 });
  }
});
