import { describe, expect, it } from "vitest";
import {
  getSdkSyncPath,
  getSdkSyncUrl,
  oauthCallback,
  stravaWebhookEvent,
  stravaWebhookVerify,
  WearablesClient,
} from "./index";

describe("sdk route helpers", () => {
  it("returns null when the sdk sync route is not configured", () => {
    expect(getSdkSyncPath()).toBeNull();
    expect(getSdkSyncUrl("https://example.convex.site")).toBeNull();
  });

  it("returns the default sdk sync path and url when enabled", () => {
    const config = { sdk: {} };
    const client = new WearablesClient({}, { providers: {} });

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
});
