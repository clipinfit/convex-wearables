import { describe, expect, it } from "vitest";
import {
  getDefaultLiveSyncMode,
  getProviderCapabilities,
  getProviderCapabilityInfo,
  getSdkSyncPath,
  getSdkSyncUrl,
  oauthCallback,
  registerRoutes,
  stravaWebhookEvent,
  stravaWebhookVerify,
  WearablesClient,
  type WearablesComponent,
} from "./index";

describe("sdk route helpers", () => {
  it("returns null when the sdk sync route is not configured", () => {
    expect(getSdkSyncPath()).toBeNull();
    expect(getSdkSyncUrl("https://example.convex.site")).toBeNull();
  });

  it("returns the default sdk sync path and url when enabled", () => {
    const config = { sdk: {} };
    const client = new WearablesClient({} as WearablesComponent, { providers: {} });

    expect(getSdkSyncPath(config)).toBe("/sdk/sync");
    expect(getSdkSyncUrl("https://example.convex.site", config)).toBe(
      "https://example.convex.site/sdk/sync",
    );
    expect(client.getSdkSyncPath(config)).toBe("/sdk/sync");
    expect(client.getSdkSyncUrl("https://example.convex.site", config)).toBe(
      "https://example.convex.site/sdk/sync",
    );
  });

  it("respects a custom sdk sync path", () => {
    const config = {
      sdk: {
        syncPath: "/mobile/sdk-sync",
      },
    };

    expect(getSdkSyncPath(config)).toBe("/mobile/sdk-sync");
    expect(getSdkSyncUrl("https://example.convex.site/", config)).toBe(
      "https://example.convex.site/mobile/sdk-sync",
    );
  });
});

describe("durable deletion client API", () => {
  it("forwards lifecycle mutations, queries, and provider deregistration", async () => {
    const component = {
      lifecycle: {
        startProviderDataDeletion: "startProviderDataDeletion",
        startUserDataDeletion: "startUserDataDeletion",
        getDataDeletionOperation: "getDataDeletionOperation",
        getActiveDataDeletionOperation: "getActiveDataDeletionOperation",
        retryDataDeletion: "retryDataDeletion",
        cancelDataDeletion: "cancelDataDeletion",
        cleanupDataDeletionOperation: "cleanupDataDeletionOperation",
        deregisterProvider: "deregisterProvider",
      },
    } as unknown as WearablesComponent;
    const client = new WearablesClient(component, { providers: {} });
    const calls: Array<{ kind: string; ref: unknown; args: unknown }> = [];
    const mutationCtx: Parameters<WearablesClient["startProviderDataDeletion"]>[0] = {
      runMutation: async (...callArgs: unknown[]) => {
        const [ref, args] = callArgs;
        calls.push({ kind: "mutation", ref, args });
        if (ref === "startProviderDataDeletion" || ref === "startUserDataDeletion") {
          return {
            operationId: "operation-1",
            workflowId: "workflow-1",
            deduped: false,
          } as never;
        }
        return null as never;
      },
    };
    const queryCtx: Parameters<WearablesClient["getDataDeletionOperation"]>[0] = {
      runQuery: async (...callArgs: unknown[]) => {
        const [ref, args] = callArgs;
        calls.push({ kind: "query", ref, args });
        return null as never;
      },
    };
    const actionCtx: Parameters<WearablesClient["deregisterProvider"]>[0] = {
      runAction: async (...callArgs: unknown[]) => {
        const [ref, args] = callArgs;
        calls.push({ kind: "action", ref, args });
        return { connectionFound: true, status: "completed" } as never;
      },
    };

    await client.startProviderDataDeletion(mutationCtx, {
      userId: "user-1",
      provider: "garmin",
      idempotencyKey: "remove-garmin",
      deregister: true,
    });
    await client.startUserDataDeletion(mutationCtx, {
      userId: "user-1",
      idempotencyKey: "remove-user",
    });
    await client.getDataDeletionOperation(queryCtx, { operationId: "operation-1" });
    await client.getActiveDataDeletionOperation(queryCtx, {
      userId: "user-1",
      provider: "garmin",
    });
    await client.retryDataDeletion(mutationCtx, { operationId: "operation-1" });
    await client.cancelDataDeletion(mutationCtx, { operationId: "operation-1" });
    await client.cleanupDataDeletionOperation(mutationCtx, { operationId: "operation-1" });
    await client.deregisterProvider(actionCtx, { userId: "user-1", provider: "garmin" });

    expect(calls).toEqual([
      {
        kind: "mutation",
        ref: "startProviderDataDeletion",
        args: {
          userId: "user-1",
          provider: "garmin",
          idempotencyKey: "remove-garmin",
          deregister: true,
        },
      },
      {
        kind: "mutation",
        ref: "startUserDataDeletion",
        args: { userId: "user-1", idempotencyKey: "remove-user" },
      },
      {
        kind: "query",
        ref: "getDataDeletionOperation",
        args: { operationId: "operation-1" },
      },
      {
        kind: "query",
        ref: "getActiveDataDeletionOperation",
        args: { userId: "user-1", provider: "garmin" },
      },
      { kind: "mutation", ref: "retryDataDeletion", args: { operationId: "operation-1" } },
      { kind: "mutation", ref: "cancelDataDeletion", args: { operationId: "operation-1" } },
      {
        kind: "mutation",
        ref: "cleanupDataDeletionOperation",
        args: { operationId: "operation-1" },
      },
      {
        kind: "action",
        ref: "deregisterProvider",
        args: { userId: "user-1", provider: "garmin" },
      },
    ]);
  });
});

describe("package exports", () => {
  it("re-exports standalone http handlers from the package root", () => {
    expect(typeof oauthCallback).toBe("function");
    expect(typeof stravaWebhookVerify).toBe("function");
    expect(typeof stravaWebhookEvent).toBe("function");
  });

  it("exposes time-series storage policy helpers on the client", async () => {
    const component = {
      dataPoints: {
        getTimeSeriesPolicyConfiguration: "getPolicyConfiguration",
        getUserTimeSeriesPolicyPreset: "getUserPreset",
        getEffectiveTimeSeriesPolicy: "getEffectivePolicy",
        replaceTimeSeriesPolicyConfiguration: "replacePolicyConfiguration",
        setUserTimeSeriesPolicyPreset: "setUserPreset",
      },
    } as unknown as WearablesComponent;

    const client = new WearablesClient(component, { providers: {} });

    const queryCalls: Array<{ ref: unknown; args: unknown }> = [];
    const mutationCalls: Array<{ ref: unknown; args: unknown }> = [];

    const queryCtx: Parameters<WearablesClient["getTimeSeriesPolicyConfiguration"]>[0] = {
      runQuery: async (...args: unknown[]) => {
        const [ref, queryArgs] = args as unknown as [unknown, unknown?];
        queryCalls.push({ ref, args: queryArgs });
        return null as never;
      },
    };
    const mutationCtx: Parameters<WearablesClient["replaceTimeSeriesPolicyConfiguration"]>[0] = {
      runMutation: async (...args: unknown[]) => {
        const [ref, mutationArgs] = args as unknown as [unknown, unknown?];
        mutationCalls.push({ ref, args: mutationArgs });
        return null as never;
      },
    };

    await client.getTimeSeriesPolicyConfiguration(queryCtx);
    await client.getUserTimeSeriesPolicyPreset(queryCtx, {
      userId: "user-1",
    });
    await client.getEffectiveTimeSeriesPolicy(queryCtx, {
      userId: "user-1",
      provider: "garmin",
      seriesType: "heart_rate",
    });
    await client.replaceTimeSeriesPolicyConfiguration(mutationCtx, {
      defaultRules: [
        {
          provider: "garmin",
          seriesType: "heart_rate",
          tiers: [
            { kind: "raw", fromAge: "0m", toAge: "24h" },
            { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
            { kind: "rollup", fromAge: "7d", toAge: null, bucket: "3h" },
          ],
        },
      ],
    });
    await client.setUserTimeSeriesPolicyPreset(mutationCtx, {
      userId: "user-1",
      presetKey: "pro",
    });

    expect(queryCalls).toEqual([
      { ref: "getPolicyConfiguration", args: {} },
      { ref: "getUserPreset", args: { userId: "user-1" } },
      {
        ref: "getEffectivePolicy",
        args: {
          userId: "user-1",
          provider: "garmin",
          seriesType: "heart_rate",
        },
      },
    ]);
    expect(mutationCalls).toEqual([
      {
        ref: "replacePolicyConfiguration",
        args: {
          defaultRules: [
            {
              provider: "garmin",
              seriesType: "heart_rate",
              tiers: [
                { kind: "raw", fromAge: "0m", toAge: "24h" },
                { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
                { kind: "rollup", fromAge: "7d", toAge: null, bucket: "3h" },
              ],
            },
          ],
        },
      },
      {
        ref: "setUserPreset",
        args: {
          userId: "user-1",
          presetKey: "pro",
        },
      },
    ]);
  });

  it("requires userland enablement and routes generation through the synthetic provider", async () => {
    const component = {
      synthetic: {
        clear: "clearSyntheticData",
        seed: "seedSyntheticData",
        status: "getSyntheticDataStatus",
      },
    } as unknown as WearablesComponent;
    const disabledClient = new WearablesClient(component, { providers: {} });
    const client = new WearablesClient(component, {
      providers: { synthetic: { enabled: true } },
    });
    const calls: Array<{ kind: string; ref: unknown; args: unknown }> = [];
    const queryCtx: Parameters<WearablesClient["getSyntheticDataStatus"]>[0] = {
      runQuery: async (...args: unknown[]) => {
        calls.push({ kind: "query", ref: args[0], args: args[1] });
        return null as never;
      },
    };
    const mutationCtx: Parameters<WearablesClient["clearSyntheticData"]>[0] = {
      runMutation: async (...args: unknown[]) => {
        calls.push({ kind: "mutation", ref: args[0], args: args[1] });
        return null as never;
      },
    };
    const target = { userId: "user-1" };
    const seed = {
      ...target,
      startDate: "2026-07-13",
      endDate: "2026-07-19",
      timezone: "Europe/Madrid",
    };

    expect(client.isSyntheticProviderEnabled()).toBe(true);
    expect(disabledClient.isSyntheticProviderEnabled()).toBe(false);
    await expect(disabledClient.seedSyntheticData(mutationCtx, seed)).rejects.toThrow(
      "synthetic provider is disabled",
    );
    await client.seedSyntheticData(mutationCtx, seed);
    await client.getSyntheticDataStatus(queryCtx, target);
    await client.clearSyntheticData(mutationCtx, target);

    expect(calls).toEqual([
      { kind: "mutation", ref: "seedSyntheticData", args: seed },
      { kind: "query", ref: "getSyntheticDataStatus", args: target },
      { kind: "mutation", ref: "clearSyntheticData", args: target },
    ]);
  });

  it("exposes additive provider capability metadata", () => {
    const client = new WearablesClient({} as WearablesComponent, { providers: {} });

    expect(getProviderCapabilities("garmin")).toMatchObject({
      generated: false,
      restPull: false,
      webhookCallback: true,
      webhookStream: true,
      maxHistoricalDays: 30,
    });
    expect(getProviderCapabilityInfo("garmin")).toMatchObject({
      defaultLiveSyncMode: "webhook",
      liveSyncConfigurable: false,
      supportsManualSync: false,
      supportsHistoricalSync: true,
      supportsBackfill: true,
    });
    expect(getProviderCapabilityInfo("strava")).toMatchObject({
      restPull: true,
      webhookPing: true,
      defaultLiveSyncMode: "pull",
      liveSyncConfigurable: true,
      supportsManualSync: true,
    });
    expect(getProviderCapabilityInfo("google")).toMatchObject({
      clientSdk: true,
      defaultLiveSyncMode: null,
      supportsManualSync: false,
      supportsHistoricalSync: false,
    });
    expect(getProviderCapabilityInfo("synthetic")).toMatchObject({
      generated: true,
      defaultLiveSyncMode: null,
      supportsManualSync: false,
      supportsHistoricalSync: false,
    });
    expect(getDefaultLiveSyncMode("whoop")).toBe("pull");
    expect(client.getProviderCapabilityInfo("apple")).toMatchObject({
      provider: "apple",
      clientSdk: true,
      implemented: true,
    });
    expect(client.getAllProviderCapabilityInfo()).toHaveLength(9);
  });

  it("passes provider-specific pull lookback configuration to sync actions", async () => {
    const component = {
      syncWorkflow: {
        syncConnection: "syncConnection",
      },
    } as unknown as WearablesComponent;
    const client = new WearablesClient(component, {
      providers: {
        strava: { clientId: "client-id", clientSecret: "client-secret" },
      },
      pullSyncLookbackHours: { strava: 12 },
    });
    const calls: Array<{ ref: unknown; args: unknown }> = [];
    const ctx: Parameters<WearablesClient["syncConnection"]>[0] = {
      runAction: async (...args: unknown[]) => {
        calls.push({ ref: args[0], args: args[1] });
        return { syncJobId: "job-1", workflowId: "workflow-1", deduped: false } as never;
      },
    };

    await client.syncConnection(ctx, {
      connectionId: "connection-1",
      provider: "strava",
      syncWindowHours: 24,
    });

    expect(calls).toEqual([
      {
        ref: "syncConnection",
        args: expect.objectContaining({
          connectionId: "connection-1",
          provider: "strava",
          lookbackHours: 12,
          syncWindowHours: 24,
        }),
      },
    ]);
  });
});

describe("registerRoutes", () => {
  it("schedules Garmin push ingestion and acknowledges the webhook immediately", async () => {
    const routes: Array<{
      handler: { _handler: (ctx: unknown, request: Request) => Promise<Response> };
      method: string;
      path: string;
    }> = [];
    const http = {
      route: (route: (typeof routes)[number]) => {
        routes.push(route);
      },
    };
    const processPushPayload = "wearables.garminWebhooks.processPushPayload";
    const component = {
      garminWebhooks: {
        processPushPayload,
      },
    } as unknown as WearablesComponent;

    registerRoutes(http as never, component, {
      garmin: {
        clientId: "garmin-client-id",
        oauthCallbackPath: false,
        webhookPath: "/webhooks/garmin/push",
        healthPath: false,
      },
    });

    const pushRoute = routes.find(
      (route) => route.path === "/webhooks/garmin/push" && route.method === "POST",
    );
    expect(pushRoute).toBeDefined();

    const scheduled: Array<{ delayMs: number; functionRef: unknown; args: unknown }> = [];
    const ctx = {
      scheduler: {
        runAfter: async (delayMs: number, functionRef: unknown, args: unknown) => {
          scheduled.push({ delayMs, functionRef, args });
          return "scheduled-garmin-push";
        },
      },
    };

    const response = await pushRoute!.handler._handler(
      ctx,
      new Request("https://example.com/webhooks/garmin/push", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "garmin-client-id": "garmin-client-id",
        },
        body: JSON.stringify({
          dailies: [
            {
              userId: "garmin-user-1",
              summaryId: "daily-1",
              startTimeInSeconds: 1_776_988_800,
              durationInSeconds: 86_400,
              steps: 12_345,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      delayMs: 0,
      functionRef: processPushPayload,
    });
    expect(scheduled[0]?.args).toMatchObject({
      garminClientId: "garmin-client-id",
    });
    expect(JSON.parse((scheduled[0]?.args as { payloadJson: string }).payloadJson)).toMatchObject({
      dailies: [{ summaryId: "daily-1" }],
    });
  });
});
