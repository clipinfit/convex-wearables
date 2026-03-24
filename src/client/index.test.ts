import { describe, expect, it } from "vitest";
import {
  getSdkSyncPath,
  getSdkSyncUrl,
  oauthCallback,
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
});
