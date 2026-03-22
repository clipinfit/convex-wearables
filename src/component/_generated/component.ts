/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type { GenericId as ConvexId } from "convex/values";

type Modules = {
  backfillJobs: typeof import("../backfillJobs.js");
  connections: typeof import("../connections.js");
  dataPoints: typeof import("../dataPoints.js");
  dataSources: typeof import("../dataSources.js");
  events: typeof import("../events.js");
  garminBackfill: typeof import("../garminBackfill.js");
  garminWebhooks: typeof import("../garminWebhooks.js");
  lifecycle: typeof import("../lifecycle.js");
  menstrualCycles: typeof import("../menstrualCycles.js");
  oauthActions: typeof import("../oauthActions.js");
  sdkPush: typeof import("../sdkPush.js");
  summaries: typeof import("../summaries.js");
  syncJobs: typeof import("../syncJobs.js");
  syncWorkflow: typeof import("../syncWorkflow.js");
};

type PublicApi = FilterApi<
  ApiFromModules<Modules>,
  FunctionReference<any, "public", any, any>
>;

type ConvertComponentBoundary<T> =
  T extends ConvexId<string>
    ? string
    : T extends readonly (infer Item)[]
      ? Array<ConvertComponentBoundary<Item>>
      : T extends object
        ? { [Key in keyof T]: ConvertComponentBoundary<T[Key]> }
        : T;

type ConvertComponentArgs<Args extends Record<string, any>> = {
  [Key in keyof Args]: ConvertComponentBoundary<Args[Key]>;
};

type ToComponentApi<API, Name extends string | undefined> =
  API extends FunctionReference<infer Type, any, infer Args, infer ReturnType>
    ? FunctionReference<
        Type,
        "internal",
        ConvertComponentArgs<Args>,
        ConvertComponentBoundary<ReturnType>,
        Name
      >
    : API extends object
      ? { [Key in keyof API]: ToComponentApi<API[Key], Name> }
      : never;

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  ToComponentApi<PublicApi, Name>;
