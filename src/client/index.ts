/**
 * @clipin/convex-wearables
 *
 * Convex component for wearable device integrations.
 * Provides health data sync from Garmin, Strava, Whoop, Polar, Suunto,
 * Apple HealthKit, Samsung Health, Google Health Connect, and SynthDevice.
 */

import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpRouter,
} from "convex/server";
import { httpActionGeneric } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  getAllProviderCapabilityInfo as getAllProviderCapabilityInfoValue,
  getProviderCapabilities as getProviderCapabilitiesValue,
  getProviderCapabilityInfo as getProviderCapabilityInfoValue,
} from "./providerCapabilities.js";
import type {
  AggregateStats,
  BackfillJob,
  Connection,
  CredentialedProviderName,
  DailySummary,
  DataDeletionCounts,
  DataDeletionOperation,
  DataDeletionScope,
  DataDeletionStatus,
  DataPoint,
  EffectiveTimeSeriesPolicy,
  EventCategory,
  EventsPage,
  GarminRoutesConfig,
  HealthEvent,
  LiveSyncMode,
  ProviderCapabilities,
  ProviderCapabilityInfo,
  ProviderConfiguration,
  ProviderCredentials,
  ProviderDeregistrationResult,
  ProviderDeregistrationStatus,
  ProviderName,
  RegisterRoutesConfig,
  SdkPushDataPoint,
  SdkPushEvent,
  SdkPushPayload,
  SdkPushSummary,
  SdkRoutesConfig,
  SdkSyncPayload,
  SeedSyntheticDataInput,
  SeedSyntheticDataResult,
  StartDataDeletionResult,
  SyncJob,
  SyncStatus,
  SyntheticDataClearCounts,
  SyntheticDataProfile,
  SyntheticDataStatus,
  SyntheticDataTarget,
  SyntheticProviderConfig,
  TimeSeriesMaintenanceInput,
  TimeSeriesPage,
  TimeSeriesPolicyConfiguration,
  TimeSeriesPolicyPresetInput,
  TimeSeriesPolicyRuleInput,
  UserTimeSeriesPolicyPreset,
  WearablesConfig,
} from "./types.js";

export {
  oauthCallback,
  stravaWebhookEvent,
  stravaWebhookVerify,
} from "../component/httpHandlers.js";
export {
  createProviderCapabilities,
  getAllProviderCapabilityInfo,
  getDefaultLiveSyncMode,
  getProviderCapabilities,
  getProviderCapabilityInfo,
  isLiveSyncConfigurable,
  PROVIDER_NAMES,
  supportsBackfill,
  supportsHistoricalSync,
  supportsManualSync,
} from "./providerCapabilities.js";
export type { SeriesType, SleepEvent, SleepStage, WorkoutEvent } from "./types.js";
export { SERIES_TYPES } from "./types.js";
// Re-export types for consumers
export type {
  AggregateStats,
  BackfillJob,
  Connection,
  CredentialedProviderName,
  DailySummary,
  DataDeletionCounts,
  DataDeletionOperation,
  DataDeletionScope,
  DataDeletionStatus,
  DataPoint,
  EffectiveTimeSeriesPolicy,
  EventCategory,
  EventsPage,
  GarminRoutesConfig,
  HealthEvent,
  LiveSyncMode,
  ProviderCapabilities,
  ProviderCapabilityInfo,
  ProviderConfiguration,
  ProviderCredentials,
  ProviderDeregistrationResult,
  ProviderDeregistrationStatus,
  ProviderName,
  RegisterRoutesConfig,
  SdkPushDataPoint,
  SdkPushEvent,
  SdkPushPayload,
  SdkPushSummary,
  SdkRoutesConfig,
  SdkSyncPayload,
  SeedSyntheticDataInput,
  SeedSyntheticDataResult,
  StartDataDeletionResult,
  SyncJob,
  SyncStatus,
  SyntheticDataClearCounts,
  SyntheticDataProfile,
  SyntheticDataStatus,
  SyntheticDataTarget,
  SyntheticProviderConfig,
  TimeSeriesMaintenanceInput,
  TimeSeriesPage,
  TimeSeriesPolicyConfiguration,
  TimeSeriesPolicyPresetInput,
  TimeSeriesPolicyRuleInput,
  UserTimeSeriesPolicyPreset,
  WearablesConfig,
};

// ---------------------------------------------------------------------------
// Component type — represents the installed component reference
// ---------------------------------------------------------------------------

export type WearablesComponent = ComponentApi;
type QueryRunner =
  | Pick<GenericQueryCtx<GenericDataModel>, "runQuery">
  | Pick<GenericActionCtx<GenericDataModel>, "runQuery">;
type MutationRunner =
  | Pick<GenericMutationCtx<GenericDataModel>, "runMutation">
  | Pick<GenericActionCtx<GenericDataModel>, "runMutation">;
type ActionRunner = Pick<GenericActionCtx<GenericDataModel>, "runAction">;

const GARMIN_PUSH_COMPONENT_FUNCTION = "wearables.garminWebhooks.processPushPayload";

// ---------------------------------------------------------------------------
// WearablesClient — the main API surface for host apps
// ---------------------------------------------------------------------------

/**
 * Client for interacting with the @clipin/convex-wearables component.
 *
 * @example
 * ```ts
 * import { WearablesClient } from "@clipin/convex-wearables";
 * import { components } from "./_generated/api";
 *
 * const wearables = new WearablesClient(components.wearables, {
 *   providers: {
 *     strava: { clientId: "...", clientSecret: "..." },
 *     garmin: { clientId: "...", clientSecret: "..." },
 *   },
 * });
 *
 * // In a query:
 * export const getWorkouts = query({
 *   args: { userId: v.string() },
 *   handler: async (ctx, args) => {
 *     return await wearables.getEvents(ctx, {
 *       userId: args.userId,
 *       category: "workout",
 *     });
 *   },
 * });
 * ```
 */
export class WearablesClient {
  public component: WearablesComponent;
  public config: WearablesConfig;

  constructor(component: WearablesComponent, config: WearablesConfig) {
    this.component = component;
    this.config = config;
  }

  private resolvePullSyncLookbackHours(
    provider: ProviderName,
    explicit?: number,
  ): number | undefined {
    if (explicit !== undefined) return explicit;
    const configured = this.config.pullSyncLookbackHours;
    if (typeof configured === "number" || configured === undefined) {
      return configured;
    }
    return configured[provider as CredentialedProviderName];
  }

  /**
   * Get static delivery/sync capabilities for a provider.
   */
  getProviderCapabilities(provider: ProviderName): ProviderCapabilities {
    return getProviderCapabilitiesValue(provider);
  }

  /**
   * Get static provider capabilities plus derived UI-friendly flags.
   */
  getProviderCapabilityInfo(provider: ProviderName): ProviderCapabilityInfo {
    return getProviderCapabilityInfoValue(provider);
  }

  /**
   * Get static capability info for every supported provider.
   */
  getAllProviderCapabilityInfo(): ProviderCapabilityInfo[] {
    return getAllProviderCapabilityInfoValue();
  }

  // -----------------------------------------------------------------------
  // Connection Management
  // -----------------------------------------------------------------------

  /**
   * Get all connections for a user.
   */
  async getConnections(ctx: QueryRunner, args: { userId: string }): Promise<Connection[]> {
    return await ctx.runQuery(this.component.connections.getConnections, {
      userId: args.userId,
    });
  }

  /**
   * Get connection for a specific user + provider.
   */
  async getConnection(
    ctx: QueryRunner,
    args: { userId: string; provider: ProviderName },
  ): Promise<Connection | null> {
    return await ctx.runQuery(this.component.connections.getByUserProvider, args);
  }

  /**
   * Get sync status for a user across all providers.
   */
  async getSyncStatus(ctx: QueryRunner, args: { userId: string }): Promise<SyncStatus[]> {
    return await ctx.runQuery(this.component.connections.getSyncStatus, {
      userId: args.userId,
    });
  }

  /**
   * Disconnect a provider for a user.
   */
  async disconnect(ctx: MutationRunner, args: { userId: string; provider: ProviderName }) {
    return await ctx.runMutation(this.component.connections.disconnect, args);
  }

  // -----------------------------------------------------------------------
  // Data Access — Events (Workouts, Sleep)
  // -----------------------------------------------------------------------

  /**
   * Get events (workouts or sleep) for a user with pagination.
   */
  async getEvents(
    ctx: QueryRunner,
    args: {
      userId: string;
      category: EventCategory;
      startDate?: number;
      endDate?: number;
      limit?: number;
      cursor?: string;
    },
  ): Promise<EventsPage> {
    return await ctx.runQuery(this.component.events.getEvents, args);
  }

  /**
   * Get a single event by ID.
   */
  async getEvent(ctx: QueryRunner, args: { eventId: string }): Promise<HealthEvent | null> {
    return await ctx.runQuery(this.component.events.getEvent, {
      eventId: args.eventId,
    });
  }

  // -----------------------------------------------------------------------
  // Data Access — Time Series
  // -----------------------------------------------------------------------

  /**
   * Get time-series data for a user.
   */
  async getTimeSeries(
    ctx: QueryRunner,
    args: {
      userId: string;
      seriesType: string;
      startDate: number;
      endDate: number;
      limit?: number;
      order?: "asc" | "desc";
    },
  ): Promise<DataPoint[]> {
    return await ctx.runQuery(this.component.dataPoints.getTimeSeriesForUser, args);
  }

  /**
   * Get the latest data point for a metric.
   */
  async getLatestDataPoint(
    ctx: QueryRunner,
    args: { userId: string; seriesType: string },
  ): Promise<{ timestamp: number; value: number; provider: string } | null> {
    return await ctx.runQuery(this.component.dataPoints.getLatestDataPoint, args);
  }

  /**
   * Get all available series types for a user.
   */
  async getAvailableSeriesTypes(ctx: QueryRunner, args: { userId: string }): Promise<string[]> {
    return await ctx.runQuery(this.component.dataPoints.getAvailableSeriesTypes, args);
  }

  /**
   * Get persisted time-series policy configuration.
   */
  async getTimeSeriesPolicyConfiguration(ctx: QueryRunner): Promise<TimeSeriesPolicyConfiguration> {
    return (await ctx.runQuery(
      this.component.dataPoints.getTimeSeriesPolicyConfiguration,
      {},
    )) as TimeSeriesPolicyConfiguration;
  }

  /**
   * Get the preset assigned to a user, if any.
   */
  async getUserTimeSeriesPolicyPreset(
    ctx: QueryRunner,
    args: { userId: string },
  ): Promise<UserTimeSeriesPolicyPreset | null> {
    return (await ctx.runQuery(
      this.component.dataPoints.getUserTimeSeriesPolicyPreset,
      args,
    )) as UserTimeSeriesPolicyPreset | null;
  }

  /**
   * Resolve the effective time-series policy for a user/provider/series triple.
   */
  async getEffectiveTimeSeriesPolicy(
    ctx: QueryRunner,
    args: { userId: string; provider: ProviderName; seriesType: string },
  ): Promise<EffectiveTimeSeriesPolicy> {
    return (await ctx.runQuery(
      this.component.dataPoints.getEffectiveTimeSeriesPolicy,
      args,
    )) as EffectiveTimeSeriesPolicy;
  }

  /**
   * Replace the persisted time-series policy configuration.
   */
  async replaceTimeSeriesPolicyConfiguration(
    ctx: MutationRunner,
    args: {
      defaultRules: TimeSeriesPolicyRuleInput[];
      presets?: TimeSeriesPolicyPresetInput[];
      maintenance?: TimeSeriesMaintenanceInput;
    },
  ): Promise<{ defaultRulesStored: number; presetsStored: number }> {
    return await ctx.runMutation(
      this.component.dataPoints.replaceTimeSeriesPolicyConfiguration,
      args,
    );
  }

  /**
   * Assign or clear a user-specific policy preset.
   */
  async setUserTimeSeriesPolicyPreset(
    ctx: MutationRunner,
    args: { userId: string; presetKey: string | null },
  ): Promise<null> {
    return await ctx.runMutation(this.component.dataPoints.setUserTimeSeriesPolicyPreset, args);
  }

  // -----------------------------------------------------------------------
  // Data Access — Summaries
  // -----------------------------------------------------------------------

  /**
   * Get daily summaries for a user.
   *
   * If provider is omitted, this returns provider-mixed storage rows. Multi-provider
   * apps should pass provider or apply their own canonical precedence before display.
   */
  async getDailySummaries(
    ctx: QueryRunner,
    args: {
      userId: string;
      provider?: ProviderName;
      category: string;
      startDate: string;
      endDate: string;
    },
  ): Promise<DailySummary[]> {
    return await ctx.runQuery(this.component.summaries.getDailySummaries, args);
  }

  // -----------------------------------------------------------------------
  // Data Sources
  // -----------------------------------------------------------------------

  /**
   * Get or create a data source for a user/provider/device.
   */
  async getOrCreateDataSource(
    ctx: MutationRunner,
    args: {
      userId: string;
      provider: ProviderName;
      connectionId?: string;
      deviceModel?: string;
      source?: string;
      deviceType?: string;
    },
  ): Promise<string> {
    return await ctx.runMutation(this.component.dataSources.getOrCreate, args);
  }

  // -----------------------------------------------------------------------
  // Sync Control
  // -----------------------------------------------------------------------

  /**
   * Get sync jobs for a user.
   */
  async getSyncJobs(
    ctx: QueryRunner,
    args: { userId: string; limit?: number },
  ): Promise<SyncJob[]> {
    return await ctx.runQuery(this.component.syncJobs.getByUser, args);
  }

  /**
   * Generate an OAuth authorization URL for a provider using configured credentials.
   */
  async generateAuthUrl(
    ctx: ActionRunner,
    args: { userId: string; provider: ProviderName; redirectUri: string },
  ): Promise<string> {
    const credentials = this.requireProviderCredentials(args.provider);

    return await ctx.runAction(this.component.oauthActions.generateAuthUrl, {
      userId: args.userId,
      provider: args.provider,
      redirectUri: args.redirectUri,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      subscriptionKey: credentials.subscriptionKey,
    });
  }

  /**
   * Handle an OAuth callback using configured provider credentials.
   */
  async handleCallback(
    ctx: ActionRunner,
    args: { provider: ProviderName; state: string; code: string },
  ): Promise<{ provider: string; userId: string; connectionId: string }> {
    const credentials = this.requireProviderCredentials(args.provider);

    return await ctx.runAction(this.component.oauthActions.handleCallback, {
      state: args.state,
      code: args.code,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      subscriptionKey: credentials.subscriptionKey,
    });
  }

  /**
   * Enqueue a durable sync for a specific connection.
   */
  async syncConnection(
    ctx: ActionRunner,
    args: {
      connectionId: string;
      startDate?: number;
      endDate?: number;
      lookbackHours?: number;
      syncWindowHours?: number;
      provider: ProviderName;
    },
  ): Promise<{ syncJobId: string; workflowId: string; deduped: boolean }> {
    const credentials = this.requireProviderCredentials(args.provider);

    return await ctx.runAction(this.component.syncWorkflow.syncConnection, {
      connectionId: args.connectionId,
      provider: args.provider,
      startDate: args.startDate,
      endDate: args.endDate,
      lookbackHours: this.resolvePullSyncLookbackHours(args.provider, args.lookbackHours),
      syncWindowHours: args.syncWindowHours,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      subscriptionKey: credentials.subscriptionKey,
    });
  }

  /**
   * Run a sync across all active connections using the configured provider credentials.
   */
  async syncAllActive(
    ctx: ActionRunner,
    args?: { lookbackHours?: number; syncWindowHours?: number },
  ) {
    const configured = this.config.providers;
    const lookbackHoursByProvider = Object.fromEntries(
      (["strava", "garmin", "polar", "whoop", "suunto"] as const)
        .map((provider) => [
          provider,
          this.resolvePullSyncLookbackHours(provider, args?.lookbackHours),
        ])
        .filter((entry): entry is [(typeof entry)[0], number] => entry[1] !== undefined),
    );
    return await ctx.runAction(this.component.syncWorkflow.syncAllActive, {
      clientCredentials: {
        garmin: configured.garmin,
        polar: configured.polar,
        strava: configured.strava,
        suunto: configured.suunto,
        whoop: configured.whoop,
      },
      lookbackHoursByProvider,
      syncWindowHours: args?.syncWindowHours,
    });
  }

  /**
   * Start a durable Garmin historical backfill workflow.
   */
  async startGarminBackfill(
    ctx: ActionRunner,
    args: {
      connectionId: string;
      kind?: "full" | "recent";
      lookbackDays?: number;
      windowStart?: number;
      windowEnd?: number;
    },
  ): Promise<{ backfillJobId: string; workflowId: string; deduped: boolean }> {
    const credentials = this.requireProviderCredentials("garmin");
    return await ctx.runAction(this.component.garminBackfill.startGarminBackfill, {
      connectionId: args.connectionId,
      kind: args.kind,
      lookbackDays: args.lookbackDays,
      windowStart: args.windowStart,
      windowEnd: args.windowEnd,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
  }

  /**
   * Get the latest Garmin backfill job for a connection.
   */
  async getGarminBackfillStatus(
    ctx: QueryRunner,
    args: { connectionId: string },
  ): Promise<BackfillJob | null> {
    return await ctx.runQuery(this.component.backfillJobs.getLatestByConnection, {
      connectionId: args.connectionId,
    });
  }

  // -----------------------------------------------------------------------
  // Synthetic provider
  // -----------------------------------------------------------------------

  /**
   * Whether the host explicitly enabled the synthetic provider.
   */
  isSyntheticProviderEnabled(): boolean {
    return this.config.providers.synthetic?.enabled === true;
  }

  /**
   * Generate deterministic normalized wearable data through the synthetic provider.
   */
  async seedSyntheticData(
    ctx: MutationRunner,
    args: SeedSyntheticDataInput,
  ): Promise<SeedSyntheticDataResult> {
    this.requireSyntheticProviderEnabled();
    return await ctx.runMutation(this.component.synthetic.seed, args);
  }

  /**
   * Clear only the matching synthetic data set. Real provider data is never removed.
   */
  async clearSyntheticData(
    ctx: MutationRunner,
    args: SyntheticDataTarget,
  ): Promise<SyntheticDataClearCounts> {
    this.requireSyntheticProviderEnabled();
    return await ctx.runMutation(this.component.synthetic.clear, args);
  }

  /**
   * Inspect the user's synthetic provider data set.
   */
  async getSyntheticDataStatus(
    ctx: QueryRunner,
    args: SyntheticDataTarget,
  ): Promise<SyntheticDataStatus> {
    this.requireSyntheticProviderEnabled();
    return await ctx.runQuery(this.component.synthetic.status, args);
  }

  /**
   * Resolve the configured SDK sync path, or null if the route is disabled.
   */
  getSdkSyncPath(config?: RegisterRoutesConfig): string | null {
    return getSdkSyncPath(config);
  }

  /**
   * Resolve the full SDK sync URL for a Convex deployment.
   */
  getSdkSyncUrl(baseUrl: string, config?: RegisterRoutesConfig): string | null {
    return getSdkSyncUrl(baseUrl, config);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start a durable provider-scoped data deletion.
   *
   * Provider deregistration is explicit and disabled by default. Use the
   * returned operation ID to observe completion.
   */
  async startProviderDataDeletion(
    ctx: MutationRunner,
    args: {
      userId: string;
      provider: ProviderName;
      idempotencyKey: string;
      deregister?: boolean;
    },
  ): Promise<StartDataDeletionResult> {
    return await ctx.runMutation(this.component.lifecycle.startProviderDataDeletion, args);
  }

  /** Start a durable deletion of all wearable data for a component user. */
  async startUserDataDeletion(
    ctx: MutationRunner,
    args: {
      userId: string;
      idempotencyKey: string;
      deregisterProviders?: boolean;
    },
  ): Promise<StartDataDeletionResult> {
    return await ctx.runMutation(this.component.lifecycle.startUserDataDeletion, args);
  }

  /** Get one durable deletion operation and its aggregate progress. */
  async getDataDeletionOperation(
    ctx: QueryRunner,
    args: { operationId: string },
  ): Promise<DataDeletionOperation | null> {
    return await ctx.runQuery(this.component.lifecycle.getDataDeletionOperation, args);
  }

  /** Find the deletion operation currently fencing a user/provider scope. */
  async getActiveDataDeletionOperation(
    ctx: QueryRunner,
    args: { userId: string; provider?: ProviderName },
  ): Promise<DataDeletionOperation | null> {
    return await ctx.runQuery(this.component.lifecycle.getActiveDataDeletionOperation, args);
  }

  /** Retry a failed deletion while preserving its operation and Workflow history. */
  async retryDataDeletion(ctx: MutationRunner, args: { operationId: string }): Promise<null> {
    return await ctx.runMutation(this.component.lifecycle.retryDataDeletion, args);
  }

  /** Stop future deletion batches. Already deleted records cannot be restored. */
  async cancelDataDeletion(ctx: MutationRunner, args: { operationId: string }): Promise<null> {
    return await ctx.runMutation(this.component.lifecycle.cancelDataDeletion, args);
  }

  /** Remove a terminal operation and its completed Workflow history. */
  async cleanupDataDeletionOperation(
    ctx: MutationRunner,
    args: { operationId: string },
  ): Promise<null> {
    return await ctx.runMutation(this.component.lifecycle.cleanupDataDeletionOperation, args);
  }

  /**
   * Revoke access at a supported provider, then clear the local connection.
   * Local disconnect still occurs when remote deregistration fails.
   */
  async deregisterProvider(
    ctx: ActionRunner,
    args: { userId: string; provider: ProviderName },
  ): Promise<ProviderDeregistrationResult> {
    return await ctx.runAction(this.component.lifecycle.deregisterProvider, args);
  }

  /**
   * @deprecated Use startUserDataDeletion. This synchronous compatibility
   * helper can exceed Convex execution limits for large accounts.
   */
  async deleteAllUserData(ctx: MutationRunner, args: { userId: string }) {
    return await ctx.runMutation(this.component.lifecycle.deleteAllUserData, {
      userId: args.userId,
    });
  }

  // -----------------------------------------------------------------------
  // Provider Configuration
  // -----------------------------------------------------------------------

  /**
   * Get credentials for a provider.
   */
  getProviderCredentials(provider: ProviderName): ProviderCredentials | undefined {
    if (provider === "synthetic") return undefined;
    return this.config.providers[provider];
  }

  /**
   * Get list of configured providers.
   */
  getConfiguredProviders(): ProviderName[] {
    return (Object.keys(this.config.providers) as ProviderName[]).filter(
      (provider) => provider !== "synthetic" || this.isSyntheticProviderEnabled(),
    );
  }

  private requireProviderCredentials(provider: ProviderName): ProviderCredentials {
    const credentials = this.getProviderCredentials(provider);
    if (!credentials) {
      throw new Error(`Missing credentials for provider "${provider}"`);
    }
    return credentials;
  }

  private requireSyntheticProviderEnabled() {
    if (!this.isSyntheticProviderEnabled()) {
      throw new Error(
        "The synthetic provider is disabled. Configure providers.synthetic with { enabled: true }.",
      );
    }
  }
}

/**
 * Register HTTP routes for wearable provider integrations.
 *
 * Registers Garmin webhook routes and the optional normalized SDK push route
 * for Apple Health / Google Health Connect / Samsung Health.
 */
export function registerRoutes(
  http: HttpRouter,
  component: WearablesComponent,
  config?: RegisterRoutesConfig,
) {
  const garminConfig = config?.garmin;
  const sdkConfig = config?.sdk;
  const registerGarminRoutes = garminConfig !== false;
  const registerSdkRoutes = sdkConfig !== undefined && sdkConfig !== false;

  if (registerGarminRoutes) {
    const webhookPath = garminConfig?.webhookPath ?? "/webhooks/garmin/push";
    const healthPath = garminConfig?.healthPath ?? "/webhooks/garmin/health";
    const oauthCallbackPath = garminConfig?.oauthCallbackPath ?? "/oauth/garmin/callback";
    const expectedClientId = garminConfig?.clientId ?? process.env.GARMIN_CLIENT_ID;
    const clientSecret = garminConfig?.clientSecret ?? process.env.GARMIN_CLIENT_SECRET;
    const successRedirectUrl =
      garminConfig?.successRedirectUrl ??
      process.env.NEXT_PUBLIC_APP_URL ??
      "http://localhost:3000";
    const successQueryParam = garminConfig?.successQueryParam ?? "connected";

    http.route({
      path: webhookPath,
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        const garminClientId = request.headers.get("garmin-client-id");

        if (expectedClientId && garminClientId !== expectedClientId) {
          console.warn("Garmin webhook rejected invalid client ID", {
            receivedClientId: garminClientId,
            expectedClientIdConfigured: Boolean(expectedClientId),
          });
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch (error) {
          console.error("Garmin webhook received invalid JSON", {
            error: serializeError(error),
          });
          return new Response("Bad request", { status: 400 });
        }

        const payloadSummary = summarizeGarminPayload(payload);

        console.info("Garmin webhook received payload", {
          componentFunction: GARMIN_PUSH_COMPONENT_FUNCTION,
          garminClientIdPresent: garminClientId !== null,
          expectedClientIdConfigured: Boolean(expectedClientId),
          payloadSummary,
        });

        try {
          const scheduledFunctionId = await ctx.scheduler.runAfter(
            0,
            component.garminWebhooks.processPushPayload,
            {
              payloadJson: JSON.stringify(payload),
              garminClientId: garminClientId ?? "",
            },
          );

          console.info("Garmin webhook ingestion scheduled", {
            componentFunction: GARMIN_PUSH_COMPONENT_FUNCTION,
            scheduledFunctionId,
            payloadSummary,
          });

          return new Response("OK", { status: 200 });
        } catch (error) {
          const serializedError = serializeError(error);
          const isUnresolvedComponentFunction =
            serializedError.message.includes("Couldn't resolve") &&
            serializedError.message.includes(GARMIN_PUSH_COMPONENT_FUNCTION);

          console.error("Garmin webhook scheduling failed", {
            componentFunction: GARMIN_PUSH_COMPONENT_FUNCTION,
            payloadSummary,
            error: serializedError,
            diagnosis: isUnresolvedComponentFunction
              ? "Convex could not resolve the component action. This usually means the host app is running a stale uploaded component snapshot or stale generated bindings. Rebuild the component package, refresh the local dependency, and restart npx convex dev."
              : undefined,
          });
          return new Response("Internal error", { status: 500 });
        }
      }),
    });

    if (healthPath !== false) {
      http.route({
        path: healthPath,
        method: "GET",
        handler: httpActionGeneric(async () => {
          return new Response(JSON.stringify({ status: "ok", service: "garmin-webhooks" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      });
    }

    if (oauthCallbackPath !== false) {
      http.route({
        path: oauthCallbackPath,
        method: "GET",
        handler: httpActionGeneric(async (ctx, request) => {
          const url = new URL(request.url);
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            return new Response(errorPage(`OAuth error: ${error}`), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          if (!code || !state) {
            return new Response(errorPage("Missing code or state parameter"), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            });
          }

          if (!expectedClientId || !clientSecret) {
            return new Response(
              errorPage("GARMIN_CLIENT_ID and GARMIN_CLIENT_SECRET must be set"),
              {
                status: 500,
                headers: { "Content-Type": "text/html" },
              },
            );
          }

          try {
            const result = await ctx.runAction(component.oauthActions.handleCallback, {
              state,
              code,
              clientId: expectedClientId,
              clientSecret,
            });

            const redirectUrl = new URL(successRedirectUrl);
            redirectUrl.searchParams.set(successQueryParam, result.provider);

            return new Response(null, {
              status: 302,
              headers: {
                Location: redirectUrl.toString(),
              },
            });
          } catch (callbackError) {
            const message =
              callbackError instanceof Error ? callbackError.message : "Unknown error";
            return new Response(errorPage(`OAuth callback failed: ${message}`), {
              status: 500,
              headers: { "Content-Type": "text/html" },
            });
          }
        }),
      });
    }
  }

  if (registerSdkRoutes) {
    const syncPath = sdkConfig?.syncPath ?? "/sdk/sync";
    const expectedToken = sdkConfig?.authToken ?? process.env.WEARABLES_SDK_AUTH_TOKEN;

    if (syncPath !== false) {
      http.route({
        path: syncPath,
        method: "POST",
        handler: httpActionGeneric(async (ctx, request) => {
          if (expectedToken) {
            const providedToken =
              extractBearerToken(request.headers.get("authorization")) ??
              request.headers.get("x-wearables-sdk-token");

            if (providedToken !== expectedToken) {
              return new Response("Unauthorized", { status: 401 });
            }
          }

          let payload: unknown;
          try {
            payload = await request.json();
          } catch {
            return new Response("Bad request", { status: 400 });
          }

          try {
            const result = await ctx.runAction(
              component.sdkPush.ingestNormalizedPayload,
              payload as SdkPushPayload,
            );

            return new Response(JSON.stringify(result), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } catch (error) {
            console.error("SDK sync processing failed", {
              error: serializeError(error),
            });
            return new Response("Internal error", { status: 500 });
          }
        }),
      });
    }
  }
}

/**
 * Resolve the configured SDK sync path, or null if the route is not registered.
 *
 * Pass the same `RegisterRoutesConfig` you use with `registerRoutes()`.
 */
export function getSdkSyncPath(config?: RegisterRoutesConfig): string | null {
  const sdkConfig = config?.sdk;
  if (sdkConfig === undefined || sdkConfig === false) {
    return null;
  }
  if (sdkConfig.syncPath === false) {
    return null;
  }
  return sdkConfig.syncPath ?? "/sdk/sync";
}

/**
 * Resolve the full SDK sync URL for a Convex deployment, or null if disabled.
 */
export function getSdkSyncUrl(baseUrl: string, config?: RegisterRoutesConfig): string | null {
  const path = getSdkSyncPath(config);
  if (!path) {
    return null;
  }
  return new URL(path, baseUrl).toString();
}

function summarizeGarminPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return { kind: typeof payload };
  }

  return {
    kind: "object",
    keys: Object.keys(payload).sort(),
    activities: getArrayLength(payload.activities),
    activityDetails: getArrayLength(payload.activityDetails),
    sleeps: getArrayLength(payload.sleeps),
    dailies: getArrayLength(payload.dailies),
    epochs: getArrayLength(payload.epochs),
    bodyComps: getArrayLength(payload.bodyComps),
    hrv: getArrayLength(payload.hrv),
    stressDetails: getArrayLength(payload.stressDetails),
    allDayRespiration: getArrayLength(payload.allDayRespiration),
    respiration: getArrayLength(payload.respiration),
    pulseOx: getArrayLength(payload.pulseOx),
    pulseox: getArrayLength(payload.pulseox),
    bloodPressures: getArrayLength(payload.bloodPressures),
    userMetrics: getArrayLength(payload.userMetrics),
    skinTemp: getArrayLength(payload.skinTemp),
    healthSnapshot: getArrayLength(payload.healthSnapshot),
    moveIQActivities: getArrayLength(payload.moveIQActivities),
    moveiq: getArrayLength(payload.moveiq),
    menstrualCycleTracking: getArrayLength(payload.menstrualCycleTracking),
    mct: getArrayLength(payload.mct),
    userPermissionsChange: getArrayLength(payload.userPermissionsChange),
    deregistrations: getArrayLength(payload.deregistrations),
  };
}

function serializeError(error: unknown): {
  cause?: unknown;
  message: string;
  name?: string;
  stack?: string[];
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack?.split("\n").slice(0, 6),
      cause: error.cause ? serializeError(error.cause) : undefined,
    };
  }

  return {
    message:
      typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })(),
  };
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const [scheme, token] = authHeader.split(" ", 2);
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}

function getArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorPage(message: string): string {
  const safe = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><title>Error</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee">
<div style="text-align:center;max-width:400px">
<h1 style="font-size:1.25rem">Connection Failed</h1>
<p style="color:#999">${safe}</p>
<a href="/" style="color:#60a5fa;text-decoration:none">Back to app</a>
</div></body></html>`;
}
