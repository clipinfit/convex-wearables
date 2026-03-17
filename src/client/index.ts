/**
 * @clipin/convex-wearables
 *
 * Convex component for wearable device integrations.
 * Provides health data sync from Garmin, Strava, Whoop, Polar, Suunto,
 * Apple HealthKit, Samsung Health, and Google Health Connect.
 */

import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  AnyComponents,
} from "convex/server";
import type {
  ProviderName,
  ProviderCredentials,
  WearablesConfig,
  Connection,
  EventCategory,
  HealthEvent,
  DataPoint,
  TimeSeriesPage,
  EventsPage,
  DailySummary,
  SyncStatus,
  SyncJob,
  AggregateStats,
} from "./types.js";

// Re-export types for consumers
export type {
  ProviderName,
  ProviderCredentials,
  WearablesConfig,
  Connection,
  EventCategory,
  HealthEvent,
  DataPoint,
  TimeSeriesPage,
  EventsPage,
  DailySummary,
  SyncStatus,
  SyncJob,
  AggregateStats,
};
export { SERIES_TYPES } from "./types.js";
export type { SeriesType, WorkoutEvent, SleepEvent, SleepStage } from "./types.js";

// ---------------------------------------------------------------------------
// Component type — represents the installed component reference
// ---------------------------------------------------------------------------

type WearablesComponent = AnyComponents[string];
type QueryRunner =
  | Pick<GenericQueryCtx<GenericDataModel>, "runQuery">
  | Pick<GenericActionCtx<GenericDataModel>, "runQuery">;
type MutationRunner =
  | Pick<GenericMutationCtx<GenericDataModel>, "runMutation">
  | Pick<GenericActionCtx<GenericDataModel>, "runMutation">;
type ActionRunner = Pick<GenericActionCtx<GenericDataModel>, "runAction">;

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

  // -----------------------------------------------------------------------
  // Connection Management
  // -----------------------------------------------------------------------

  /**
   * Get all connections for a user.
   */
  async getConnections(
    ctx: QueryRunner,
    args: { userId: string },
  ): Promise<Connection[]> {
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
  async getSyncStatus(
    ctx: QueryRunner,
    args: { userId: string },
  ): Promise<SyncStatus[]> {
    return await ctx.runQuery(this.component.connections.getSyncStatus, {
      userId: args.userId,
    });
  }

  /**
   * Disconnect a provider for a user.
   */
  async disconnect(
    ctx: MutationRunner,
    args: { userId: string; provider: ProviderName },
  ) {
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
  async getEvent(
    ctx: QueryRunner,
    args: { eventId: string },
  ): Promise<HealthEvent | null> {
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
    },
  ): Promise<DataPoint[]> {
    return await ctx.runQuery(
      this.component.dataPoints.getTimeSeriesForUser,
      args,
    );
  }

  /**
   * Get the latest data point for a metric.
   */
  async getLatestDataPoint(
    ctx: QueryRunner,
    args: { userId: string; seriesType: string },
  ): Promise<{ timestamp: number; value: number; provider: string } | null> {
    return await ctx.runQuery(
      this.component.dataPoints.getLatestDataPoint,
      args,
    );
  }

  /**
   * Get all available series types for a user.
   */
  async getAvailableSeriesTypes(
    ctx: QueryRunner,
    args: { userId: string },
  ): Promise<string[]> {
    return await ctx.runQuery(
      this.component.dataPoints.getAvailableSeriesTypes,
      args,
    );
  }

  // -----------------------------------------------------------------------
  // Data Access — Summaries
  // -----------------------------------------------------------------------

  /**
   * Get daily summaries for a user.
   */
  async getDailySummaries(
    ctx: QueryRunner,
    args: {
      userId: string;
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
   * Create a sync job record.
   */
  async createSyncJob(
    ctx: MutationRunner,
    args: { userId: string; provider?: ProviderName },
  ): Promise<string> {
    return await ctx.runMutation(this.component.syncJobs.create, args);
  }

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
   * Run a sync across all active connections using the configured provider credentials.
   */
  async syncAllActive(
    ctx: ActionRunner,
    args?: { syncWindowHours?: number },
  ) {
    return await ctx.runAction(this.component.syncWorkflow.syncAllActive, {
      clientCredentials: this.config.providers,
      syncWindowHours: args?.syncWindowHours,
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Delete all data for a user (GDPR compliance, account deletion).
   */
  async deleteAllUserData(
    ctx: MutationRunner,
    args: { userId: string },
  ) {
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
    return this.config.providers[provider];
  }

  /**
   * Get list of configured providers.
   */
  getConfiguredProviders(): ProviderName[] {
    return Object.keys(this.config.providers) as ProviderName[];
  }

  private requireProviderCredentials(provider: ProviderName): ProviderCredentials {
    const credentials = this.getProviderCredentials(provider);
    if (!credentials) {
      throw new Error(`Missing credentials for provider "${provider}"`);
    }
    return credentials;
  }
}
