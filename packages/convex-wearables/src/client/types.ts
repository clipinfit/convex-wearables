/**
 * Shared types for @clipin/convex-wearables.
 *
 * These types are used by both the component internals and the host app.
 */

// ---------------------------------------------------------------------------
// Provider types
// ---------------------------------------------------------------------------

export type ProviderName =
  | "garmin"
  | "suunto"
  | "polar"
  | "whoop"
  | "strava"
  | "apple"
  | "samsung"
  | "google"
  | "synthetic";

export type CredentialedProviderName = Exclude<ProviderName, "synthetic">;

export type ConnectionStatus = "active" | "inactive" | "revoked" | "expired" | "error";

export type EventCategory = "workout" | "sleep";

export type SyncJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type BackfillJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type DataDeletionScope = "provider" | "user";

export type DataDeletionStatus =
  | "pending"
  | "running"
  | "completed"
  | "completed_with_warnings"
  | "failed"
  | "canceled";

export type ProviderDeregistrationStatus =
  | "not_requested"
  | "pending"
  | "completed"
  | "partially_completed"
  | "unsupported"
  | "failed";

export interface DataDeletionCounts {
  connections: number;
  dataSources: number;
  dataPoints: number;
  timeSeriesRollups: number;
  timeSeriesSeriesState: number;
  events: number;
  workoutSegments?: number;
  workoutZones?: number;
  garminActivityFileJobs?: number;
  dailySummaries: number;
  menstrualCycles: number;
  syncJobs: number;
  backfillJobs: number;
  oauthStates: number;
  pendingGarminPushPayloads: number;
  providerWebhookReceipts?: number;
  outgoingWebhookState?: number;
  timeSeriesPolicyAssignments: number;
  priorDataDeletionOperations: number;
}

export interface DataDeletionOperation {
  _id: string;
  _creationTime: number;
  userId: string;
  scope: DataDeletionScope;
  provider?: ProviderName;
  idempotencyKey: string;
  workflowId?: string;
  status: DataDeletionStatus;
  currentPhase?: string;
  requestedDeregistration: boolean;
  deregistrationStatus: ProviderDeregistrationStatus;
  deletedCounts: DataDeletionCounts;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface StartDataDeletionResult {
  operationId: string;
  workflowId: string;
  deduped: boolean;
}

export interface ProviderDeregistrationResult {
  connectionFound: boolean;
  status: "completed" | "unsupported" | "failed";
  errorCode?: string;
}

export type DurationInput = string | number;

export type TimeSeriesRollupAggregation = "avg" | "min" | "max" | "last" | "count";

export type LiveSyncMode = "pull" | "webhook";

export interface ProviderCapabilities {
  /** Provider creates deterministic generated data without an external service. */
  generated: boolean;
  /**
   * Provider exposes a REST API that can be polled for historical or recent data.
   */
  restPull: boolean;
  /**
   * Data arrives through the normalized mobile SDK push endpoint.
   */
  clientSdk: boolean;
  /**
   * Data arrives as a file import rather than provider API calls or SDK pushes.
   */
  fileImport: boolean;
  /**
   * We request a provider export/backfill and the provider calls back asynchronously.
   */
  webhookCallback: boolean;
  /**
   * Provider pushes complete data payloads inline to the component webhook.
   */
  webhookStream: boolean;
  /**
   * Provider sends lightweight notifications and data must be fetched separately.
   */
  webhookPing: boolean;
  /**
   * Provider supports programmatic webhook subscription registration.
   */
  webhookRegistrationApi: boolean;
  /**
   * Provider returns or requires a stored inbound webhook signing secret.
   */
  webhookInboundSecret: boolean;
  /**
   * Known historical sync lookback limit in days. Null means no known component-enforced limit.
   */
  maxHistoricalDays: number | null;
}

export interface ProviderCapabilityInfo extends ProviderCapabilities {
  provider: ProviderName;
  implemented: boolean;
  liveSyncConfigurable: boolean;
  defaultLiveSyncMode: LiveSyncMode | null;
  supportsManualSync: boolean;
  supportsHistoricalSync: boolean;
  supportsBackfill: boolean;
}

// ---------------------------------------------------------------------------
// Provider configuration (passed by app)
// ---------------------------------------------------------------------------

export interface ProviderCredentials {
  clientId: string;
  clientSecret: string;
  /** Suunto requires an additional subscription key. */
  subscriptionKey?: string;
}

export interface SyntheticProviderConfig {
  /** Explicit userland opt-in for generated wearable data. */
  enabled: boolean;
}

export type ProviderConfiguration = {
  [Provider in CredentialedProviderName]?: ProviderCredentials;
} & {
  synthetic?: SyntheticProviderConfig;
};

export interface WearablesConfig {
  providers: ProviderConfiguration;
  /**
   * Optional trailing overlap for live pull syncs, in hours. A number applies
   * to every pull provider; an object configures providers independently.
   * Disabled by default to preserve existing provider API usage.
   */
  pullSyncLookbackHours?: number | Partial<Record<CredentialedProviderName, number>>;
  /**
   * Optional function reference called when new data is synced.
   * The host app can use this to trigger downstream processing.
   */
  onDataSynced?: unknown; // FunctionReference — typed loosely to avoid coupling
}

export type WearablesEventType =
  | "connection.created"
  | "connection.status_changed"
  | "sync.started"
  | "sync.completed"
  | "sync.failed"
  | "workout.upserted"
  | "workout.enriched"
  | "workout.deleted"
  | "sleep.upserted"
  | "sleep.deleted"
  | "summary.upserted"
  | "series.batch.upserted"
  | `series.${string}.upserted`
  | "data_deletion.started"
  | "data_deletion.completed"
  | "data_deletion.completed_with_warnings";

export interface WearablesEventEnvelope {
  id: string;
  type: WearablesEventType;
  version: 1;
  occurredAt: number;
  tenantId: string;
  userId?: string;
  provider?: ProviderName;
  subject: {
    kind: "connection" | "sync" | "workout" | "sleep" | "summary" | "series" | "deletion";
    id?: string;
  };
  idempotencyKey: string;
  data: Record<string, unknown>;
  chunk?: { index: number; count: number };
}

export type OutgoingWebhookEndpointStatus =
  | "pending_verification"
  | "active"
  | "paused"
  | "disabled"
  | "deleted";
export type OutgoingWebhookDeliveryStatus =
  | "pending"
  | "delivering"
  | "retry_scheduled"
  | "succeeded"
  | "failed"
  | "canceled";
export type OutgoingWebhookPayloadMode = "reference" | "snapshot";
export interface OutgoingWebhookEndpoint {
  _id: string;
  tenantId: string;
  scope: "tenant" | "user";
  userId?: string;
  url: string;
  description?: string;
  eventTypes: string[];
  payloadMode: OutgoingWebhookPayloadMode;
  status: OutgoingWebhookEndpointStatus;
  signingKeyVersion: number;
  hasQueryParameters?: boolean;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  disabledReason?: string;
  createdAt: number;
  updatedAt: number;
}
export interface OutgoingWebhookDelivery {
  _id: string;
  eventId: string;
  endpointId: string;
  tenantId: string;
  userId?: string;
  status: OutgoingWebhookDeliveryStatus;
  attemptCount: number;
  nextAttemptAt?: number;
  lastResponseStatus?: number;
  lastErrorCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GarminRoutesConfig {
  /** Route that receives Garmin push notifications. */
  webhookPath?: string;
  /** Optional health-check route for the Garmin webhook integration. */
  healthPath?: string | false;
  /** Expected Garmin client ID. Defaults to `process.env.GARMIN_CLIENT_ID`. */
  clientId?: string;
  /** Garmin client secret. Defaults to `process.env.GARMIN_CLIENT_SECRET`. */
  clientSecret?: string;
  /** Route that receives the Garmin OAuth callback. */
  oauthCallbackPath?: string | false;
  /** Where to redirect after a successful OAuth callback. */
  successRedirectUrl?: string;
  /** Query parameter set on successful OAuth redirect. */
  successQueryParam?: string;
  /** Opt in to asynchronous Garmin FIT Activity File enrichment. */
  activityFiles?: {
    /** Defaults to false. */
    enabled: boolean;
    /** HTTPS callback hosts. Defaults to Garmin's API hosts. */
    allowedHosts?: string[];
    /** Maximum download size in bytes, capped at 20 MiB. */
    maxBytes?: number;
  };
}

export interface WorkoutSegment {
  _id: string;
  eventId: string;
  userId: string;
  provider: ProviderName;
  kind: "lap" | "split" | "length" | "set";
  index: number;
  startDatetime?: number;
  elapsedSeconds?: number;
  timerSeconds?: number;
  distanceMeters?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  averagePower?: number;
  maxPower?: number;
  averageCadence?: number;
  strokes?: number;
  exercise?: string;
  repetitions?: number;
  weight?: number;
  weightUnit?: string;
  setType?: string;
  schemaVersion: number;
}

export interface WorkoutZone {
  _id: string;
  eventId: string;
  userId: string;
  provider: ProviderName;
  kind: "heart_rate" | "power";
  zone: number;
  lowerBound?: number;
  upperBound?: number;
  seconds: number;
  schemaVersion: number;
}

export interface WorkoutEnrichment {
  event: HealthEvent | null;
  segments: WorkoutSegment[];
  zones: WorkoutZone[];
}

export type WorkoutSegmentInput = Omit<
  WorkoutSegment,
  "_id" | "eventId" | "userId" | "provider" | "schemaVersion"
>;
export type WorkoutZoneInput = Omit<
  WorkoutZone,
  "_id" | "eventId" | "userId" | "provider" | "schemaVersion"
>;

export interface SdkRoutesConfig {
  /** Route that receives normalized SDK/mobile health pushes. */
  syncPath?: string | false;
  /**
   * Versioned route that accepts partially valid SDK batches and returns a
   * structured ingestion report. Defaults to `/sdk/sync/v2`.
   */
  syncV2Path?: string | false;
  /**
   * Optional shared bearer token expected on the SDK sync route.
   * Defaults to `process.env.WEARABLES_SDK_AUTH_TOKEN` when omitted.
   */
  authToken?: string;
}

export type LiveWebhookProviderName = "polar" | "whoop" | "suunto";
export type ProviderWebhookReceiptStatus =
  | "pending"
  | "processing"
  | "waiting_for_connection"
  | "completed"
  | "ignored"
  | "failed"
  | "canceled";
export type ProviderWebhookRegistrationStatus =
  | "unconfigured"
  | "pending_verification"
  | "active"
  | "paused"
  | "deactivated"
  | "error";

export interface LiveProviderWebhookRoutesConfig {
  /** Mount the Polar AccessLink callback. */
  polar?: { path?: string } | false;
  /** Mount the WHOOP v2 callback. */
  whoop?: { path?: string } | false;
  /** Mount the Suunto callback. */
  suunto?: { path?: string } | false;
  /** Maximum accepted raw request size. Defaults to 512,000 bytes. */
  maxBodyBytes?: number;
}

export interface ProviderWebhookReceipt {
  _id: string;
  provider: LiveWebhookProviderName;
  eventType: string;
  status: ProviderWebhookReceiptStatus;
  receivedAt: number;
  expiresAt: number;
  attempt: number;
  connectionId?: string;
  completedAt?: number;
  resultCode?: string;
  errorCode?: string;
}

export interface ProviderWebhookStatus {
  provider: LiveWebhookProviderName;
  status: ProviderWebhookRegistrationStatus;
  targetUrl?: string;
  remoteId?: string;
  modelVersion?: "v2";
  eventTypes?: string[];
  secretConfigured: boolean;
  configuredAt?: number;
  lastVerifiedAt?: number;
  lastReconciledAt?: number;
  lastErrorCode?: string;
  updatedAt: number;
}

export interface RegisterRoutesConfig {
  /**
   * Garmin webhook routes.
   * Pass `false` to skip registering Garmin routes.
   */
  garmin?: GarminRoutesConfig | false;
  /**
   * Normalized SDK push route for Apple Health / Google Health Connect / Samsung Health.
   * Omitted by default; pass a config object to register it.
   */
  sdk?: SdkRoutesConfig | false;
  /** Opt-in Polar, WHOOP v2, and Suunto inbound webhook routes. */
  providerWebhooks?: LiveProviderWebhookRoutesConfig | false;
}

export type SdkProviderName = "apple" | "google" | "samsung";

export interface SdkDeviceMetadata {
  model?: string;
  softwareVersion?: string;
  source?: string;
  deviceType?: string;
  originalSourceName?: string;
  appId?: string;
  app_id?: string;
  bundleIdentifier?: string;
  bundle_identifier?: string;
}

export interface SdkSourceMetadata {
  deviceModel?: string;
  softwareVersion?: string;
  source?: string;
  deviceType?: string;
  originalSourceName?: string;
  appId?: string;
  app_id?: string;
  bundleIdentifier?: string;
  bundle_identifier?: string;
}

export interface SdkPushEvent extends SdkSourceMetadata {
  category: EventCategory;
  type?: string;
  sourceName?: string;
  durationSeconds?: number;
  startDatetime: number;
  endDatetime?: number;
  externalId?: string;
  heartRateMin?: number;
  heartRateMax?: number;
  heartRateAvg?: number;
  energyBurned?: number;
  distance?: number;
  stepsCount?: number;
  maxSpeed?: number;
  maxWatts?: number;
  movingTimeSeconds?: number;
  totalElevationGain?: number;
  averageSpeed?: number;
  averageWatts?: number;
  elevHigh?: number;
  elevLow?: number;
  sleepTotalDurationMinutes?: number;
  sleepTimeInBedMinutes?: number;
  sleepEfficiencyScore?: number;
  sleepDeepMinutes?: number;
  sleepRemMinutes?: number;
  sleepLightMinutes?: number;
  sleepAwakeMinutes?: number;
  isNap?: boolean;
  sleepStages?: Array<{
    stage: string;
    startTime: number;
    endTime: number;
  }>;
}

export interface SdkPushDataPoint extends SdkSourceMetadata {
  seriesType: string;
  recordedAt: number;
  value: number;
  externalId?: string;
}

export interface SdkPushSummary {
  date: string;
  category: string;
  source?: string;
  originalSourceName?: string;
  appId?: string;
  app_id?: string;
  bundleIdentifier?: string;
  bundle_identifier?: string;
  totalSteps?: number;
  totalCalories?: number;
  activeCalories?: number;
  activeMinutes?: number;
  totalDistance?: number;
  floorsClimbed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  sleepDurationMinutes?: number;
  sleepEfficiency?: number;
  deepSleepMinutes?: number;
  remSleepMinutes?: number;
  lightSleepMinutes?: number;
  awakeDuringMinutes?: number;
  timeInBedMinutes?: number;
  hrvAvg?: number;
  hrvRmssd?: number;
  restingHeartRate?: number;
  recoveryScore?: number;
  weight?: number;
  bodyFatPercentage?: number;
  bodyMassIndex?: number;
  leanBodyMass?: number;
  bodyTemperature?: number;
  avgStressLevel?: number;
  bodyBattery?: number;
  spo2Avg?: number;
}

export interface SdkPushPayload {
  userId: string;
  provider: SdkProviderName;
  providerUserId?: string;
  providerUsername?: string;
  syncTimestamp?: number;
  /**
   * Compatibility alias for older mobile payloads.
   * Prefer `sourceMetadata` for new integrations.
   */
  device?: SdkDeviceMetadata;
  sourceMetadata?: SdkSourceMetadata;
  events?: SdkPushEvent[];
  dataPoints?: SdkPushDataPoint[];
  summaries?: SdkPushSummary[];
  /**
   * Compatibility alias for older mobile payloads.
   * Prefer `summaries` for new integrations.
   */
  dailySummaries?: SdkPushSummary[];
}

export type SdkSyncPayload = SdkPushPayload;

export type SdkIngestionMode = "partial" | "strict";

export type SdkIngestionRejectionCode =
  | "invalid_envelope"
  | "invalid_type"
  | "invalid_value"
  | "limit_exceeded"
  | "missing_field"
  | "unknown_field"
  | "unsupported_series_type";

export interface SdkIngestionRejection {
  category: "payload" | "events" | "dataPoints" | "summaries" | "dailySummaries";
  index: number;
  code: SdkIngestionRejectionCode;
  path?: string;
  message: string;
}

export interface SdkIngestionCategoryCounts {
  received: number;
  accepted: number;
  rejected: number;
  stored: number;
}

export type SdkPushPayloadV2Body = Omit<SdkPushPayload, "userId" | "provider">;

export interface SdkIngestionV2Request {
  userId: string;
  provider: SdkProviderName;
  requestId: string;
  mode?: SdkIngestionMode;
  payload: SdkPushPayloadV2Body;
}

export interface SdkIngestionV2Result {
  requestId: string;
  status: "accepted" | "partially_accepted" | "rejected";
  mode: SdkIngestionMode;
  connectionId?: string;
  counts: {
    received: number;
    accepted: number;
    rejected: number;
    stored: number;
  };
  categories: {
    events: SdkIngestionCategoryCounts;
    dataPoints: SdkIngestionCategoryCounts;
    summaries: SdkIngestionCategoryCounts;
  };
  rejections: SdkIngestionRejection[];
  rejectionCountTruncated: number;
}

// ---------------------------------------------------------------------------
// Synthetic provider
// ---------------------------------------------------------------------------

export type SyntheticDataProfile = "active" | "sedentary" | "recovery" | "mixed" | "showcase";

export interface SeedSyntheticDataInput {
  userId: string;
  startDate: string;
  endDate: string;
  timezone: string;
  /**
   * Latest timestamp that generated events and time-series points may use.
   * Defaults to the mutation's current time.
   */
  asOf?: number;
  profile?: SyntheticDataProfile;
  seed?: string;
  replaceExisting?: boolean;
}

export interface SyntheticDataTarget {
  userId: string;
}

export interface SyntheticDataClearCounts {
  connections: number;
  dataSources: number;
  events: number;
  dataPoints: number;
  rollups: number;
  seriesStates: number;
  summaries: number;
  syncJobs: number;
}

export interface SeedSyntheticDataResult {
  connectionId: string;
  dataSourceId: string;
  syncJobId: string;
  startDate: string;
  endDate: string;
  eventsStored: number;
  dataPointsStored: number;
  summariesStored: number;
  lastSyncedAt: number;
  cleared: SyntheticDataClearCounts;
}

export interface SyntheticDataStatus {
  exists: boolean;
  connectionId: string | null;
  lastSyncedAt: number | null;
  startDate: string | null;
  endDate: string | null;
  counts: {
    connections: number;
    dataSources: number;
    events: number;
    dataPoints: number;
    rollups: number;
    seriesStates: number;
    summaries: number;
    syncJobs: number;
  };
}

// ---------------------------------------------------------------------------
// Connection types
// ---------------------------------------------------------------------------

export interface Connection {
  _id: string;
  userId: string;
  provider: ProviderName;
  providerUserId?: string;
  providerUsername?: string;
  status: ConnectionStatus;
  lastSyncedAt?: number;
}

/** Provider, writer, and device provenance for stored wearable data. */
export interface WearableDataSource {
  _id: string;
  _creationTime: number;
  userId: string;
  provider: ProviderName;
  connectionId?: string;
  deviceModel?: string;
  softwareVersion?: string;
  /** Provider sub-surface or source application reported during ingestion. */
  source?: string;
  deviceType?: string;
  /** Original app, package, bundle, or writer name when supplied by an SDK. */
  originalSourceName?: string;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface WorkoutEvent {
  _id: string;
  userId: string;
  category: "workout";
  type?: string;
  sourceName?: string;
  durationSeconds?: number;
  startDatetime: number;
  endDatetime?: number;
  externalId?: string;
  // Workout details
  heartRateMin?: number;
  heartRateMax?: number;
  heartRateAvg?: number;
  energyBurned?: number;
  distance?: number;
  stepsCount?: number;
  maxSpeed?: number;
  maxWatts?: number;
  movingTimeSeconds?: number;
  totalElevationGain?: number;
  averageSpeed?: number;
  averageWatts?: number;
  elevHigh?: number;
  elevLow?: number;
}

export interface SleepStage {
  stage: string;
  startTime: number;
  endTime: number;
}

export interface SleepEvent {
  _id: string;
  userId: string;
  category: "sleep";
  type?: string;
  sourceName?: string;
  durationSeconds?: number;
  startDatetime: number;
  endDatetime?: number;
  externalId?: string;
  // Sleep details
  sleepTotalDurationMinutes?: number;
  sleepTimeInBedMinutes?: number;
  sleepEfficiencyScore?: number;
  sleepDeepMinutes?: number;
  sleepRemMinutes?: number;
  sleepLightMinutes?: number;
  sleepAwakeMinutes?: number;
  isNap?: boolean;
  sleepStages?: SleepStage[];
}

export type HealthEvent = WorkoutEvent | SleepEvent;

/** Event carrying the stable key used to resolve its provider/source metadata. */
export type SourceAwareHealthEvent = HealthEvent & { dataSourceId: string };

// ---------------------------------------------------------------------------
// Data point types
// ---------------------------------------------------------------------------

export interface DataPoint {
  timestamp: number;
  value: number;
  resolution?: "raw" | "rollup";
  bucketMinutes?: number;
  avg?: number;
  min?: number;
  max?: number;
  last?: number;
  count?: number;
}

/** Time-series point carrying the stable key for its originating data source. */
export interface SourceAwareDataPoint extends DataPoint {
  dataSourceId: string;
}

export interface SourceAwareTimeSeriesResult {
  points: SourceAwareDataPoint[];
  dataSources: WearableDataSource[];
}

export interface TimeSeriesPage {
  points: DataPoint[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TimeSeriesRawTierInput {
  kind: "raw";
  fromAge: DurationInput;
  toAge: DurationInput | null;
}

export interface TimeSeriesRollupTierInput {
  kind: "rollup";
  fromAge: DurationInput;
  toAge: DurationInput | null;
  bucket: DurationInput;
  aggregations?: TimeSeriesRollupAggregation[];
}

export type TimeSeriesTierInput = TimeSeriesRawTierInput | TimeSeriesRollupTierInput;

export interface TimeSeriesPolicyRuleInput {
  provider?: ProviderName;
  seriesType?: string;
  tiers: TimeSeriesTierInput[];
}

export interface TimeSeriesPolicyPresetInput {
  key: string;
  rules: TimeSeriesPolicyRuleInput[];
}

export interface TimeSeriesMaintenanceInput {
  enabled?: boolean;
  interval?: DurationInput;
}

export interface TimeSeriesRawTier {
  kind: "raw";
  fromAgeMs: number;
  toAgeMs: number | null;
}

export interface TimeSeriesRollupTier {
  kind: "rollup";
  fromAgeMs: number;
  toAgeMs: number | null;
  bucketMs: number;
  aggregations: TimeSeriesRollupAggregation[];
}

export type TimeSeriesTier = TimeSeriesRawTier | TimeSeriesRollupTier;

export interface TimeSeriesPolicyRule {
  _id: string;
  policySetKind: "default" | "preset";
  policySetKey: string;
  updatedAt: number;
  scope: "global" | "provider" | "series" | "provider_series";
  provider?: ProviderName;
  seriesType?: string;
  tiers: TimeSeriesTier[];
}

export interface TimeSeriesPolicyPreset {
  key: string;
  rules: TimeSeriesPolicyRule[];
}

export interface TimeSeriesPolicyConfiguration {
  maintenance: {
    enabled: boolean;
    intervalMs: number;
  };
  defaultRules: TimeSeriesPolicyRule[];
  presets: TimeSeriesPolicyPreset[];
}

export interface UserTimeSeriesPolicyPreset {
  userId: string;
  presetKey: string;
  updatedAt: number;
}

export interface EffectiveTimeSeriesPolicy {
  provider: ProviderName;
  seriesType: string;
  sourceKind: "preset" | "default" | "builtin";
  sourceKey: string | null;
  matchedScope: "default" | "global" | "provider" | "series" | "provider_series";
  tiers: TimeSeriesTier[];
}

// ---------------------------------------------------------------------------
// Events page
// ---------------------------------------------------------------------------

export interface EventsPage {
  events: HealthEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SourceAwareEventsPage {
  events: SourceAwareHealthEvent[];
  dataSources: WearableDataSource[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Summary types
// ---------------------------------------------------------------------------

export interface DailySummary {
  _id: string;
  userId: string;
  provider?: ProviderName;
  dataSourceId?: string;
  source?: string;
  originalSourceName?: string;
  date: string;
  category: string;
  // Activity
  totalSteps?: number;
  totalCalories?: number;
  activeCalories?: number;
  activeMinutes?: number;
  totalDistance?: number;
  floorsClimbed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  minHeartRate?: number;
  // Sleep
  sleepDurationMinutes?: number;
  sleepEfficiency?: number;
  deepSleepMinutes?: number;
  remSleepMinutes?: number;
  lightSleepMinutes?: number;
  awakeDuringMinutes?: number;
  timeInBedMinutes?: number;
  // Recovery
  hrvAvg?: number;
  hrvRmssd?: number;
  restingHeartRate?: number;
  recoveryScore?: number;
  // Body
  weight?: number;
  bodyFatPercentage?: number;
  bodyMassIndex?: number;
  leanBodyMass?: number;
  bodyTemperature?: number;
  // Other
  avgStressLevel?: number;
  bodyBattery?: number;
  spo2Avg?: number;
}

export interface AggregateStats {
  sum: number;
  count: number;
  avg: number;
  min: number | null;
  max: number | null;
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

export interface SyncJob {
  _id: string;
  connectionId: string;
  userId: string;
  provider: ProviderName;
  status: SyncJobStatus;
  mode?: "manual" | "cron" | "webhook";
  triggerSource?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  recordsProcessed?: number;
  workflowId?: string;
  windowStart?: number;
  windowEnd?: number;
  attempt?: number;
  lastHeartbeatAt?: number;
  cursor?: string;
  currentPhase?: "events" | "dataPoints" | "summaries";
}

export interface SyncStatus {
  provider: ProviderName;
  connectionStatus: ConnectionStatus;
  lastSyncedAt?: number;
  syncJobStatus: SyncJobStatus | null;
  syncJobError: string | null;
}

export interface BackfillJob {
  _id: string;
  connectionId: string;
  userId: string;
  provider: ProviderName;
  dataType: string;
  status: BackfillJobStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  workflowId?: string;
  windowStart?: number;
  windowEnd?: number;
  currentDataType?: string;
  currentAttempt?: number;
  currentEventId?: string;
  completedDataTypes?: string[];
  lastHeartbeatAt?: number;
}

// ---------------------------------------------------------------------------
// Series type definitions — all 48 pre-defined metric types
// ---------------------------------------------------------------------------

export const SERIES_TYPES = {
  // Heart & Cardiovascular
  heart_rate: { id: 1, unit: "bpm" },
  resting_heart_rate: { id: 2, unit: "bpm" },
  heart_rate_variability_sdnn: { id: 3, unit: "ms" },
  heart_rate_recovery_one_minute: { id: 4, unit: "bpm" },
  walking_heart_rate_average: { id: 5, unit: "bpm" },
  recovery_score: { id: 6, unit: "score" },
  heart_rate_variability_rmssd: { id: 7, unit: "ms" },

  // Blood & Respiratory
  oxygen_saturation: { id: 20, unit: "percent" },
  blood_glucose: { id: 21, unit: "mg_dl" },
  blood_pressure_systolic: { id: 22, unit: "mmHg" },
  blood_pressure_diastolic: { id: 23, unit: "mmHg" },
  respiratory_rate: { id: 24, unit: "brpm" },
  sleeping_breathing_disturbances: { id: 25, unit: "count" },
  blood_alcohol_content: { id: 26, unit: "mg_dl" },
  peripheral_perfusion_index: { id: 27, unit: "score" },
  forced_vital_capacity: { id: 28, unit: "liters" },
  forced_expiratory_volume_1: { id: 29, unit: "liters" },
  peak_expiratory_flow_rate: { id: 30, unit: "L/min" },

  // Body Composition
  height: { id: 40, unit: "cm" },
  weight: { id: 41, unit: "kg" },
  body_fat_percentage: { id: 42, unit: "percent" },
  body_mass_index: { id: 43, unit: "kg_m2" },
  lean_body_mass: { id: 44, unit: "kg" },
  body_temperature: { id: 45, unit: "celsius" },
  skin_temperature: { id: 46, unit: "celsius" },
  waist_circumference: { id: 47, unit: "cm" },
  body_fat_mass: { id: 48, unit: "kg" },
  skeletal_muscle_mass: { id: 49, unit: "kg" },

  // Fitness
  vo2_max: { id: 60, unit: "ml_kg_min" },
  six_minute_walk_test_distance: { id: 61, unit: "meters" },

  // Activity — Basic
  steps: { id: 80, unit: "count" },
  energy: { id: 81, unit: "kcal" },
  basal_energy: { id: 82, unit: "kcal" },
  total_calories: { id: 88, unit: "kcal" },
  active_calories: { id: 89, unit: "kcal" },
  stand_time: { id: 83, unit: "minutes" },
  exercise_time: { id: 84, unit: "minutes" },
  physical_effort: { id: 85, unit: "score" },
  flights_climbed: { id: 86, unit: "count" },
  floors_climbed: { id: 90, unit: "count" },
  average_met: { id: 87, unit: "met" },

  // Activity — Distance
  distance: { id: 99, unit: "meters" },
  distance_walking_running: { id: 100, unit: "meters" },
  distance_cycling: { id: 101, unit: "meters" },
  distance_swimming: { id: 102, unit: "meters" },
  distance_downhill_snow_sports: { id: 103, unit: "meters" },
  distance_other: { id: 104, unit: "meters" },
  elevation_gain: { id: 105, unit: "meters" },

  // Activity — Walking
  walking_step_length: { id: 120, unit: "cm" },
  walking_speed: { id: 121, unit: "m_per_s" },
  walking_double_support_percentage: { id: 122, unit: "percent" },
  walking_asymmetry_percentage: { id: 123, unit: "percent" },
  walking_steadiness: { id: 124, unit: "percent" },
  stair_descent_speed: { id: 125, unit: "m_per_s" },
  stair_ascent_speed: { id: 126, unit: "m_per_s" },

  // Activity — Running
  running_power: { id: 140, unit: "watts" },
  running_speed: { id: 141, unit: "m_per_s" },
  running_vertical_oscillation: { id: 142, unit: "cm" },
  running_ground_contact_time: { id: 143, unit: "ms" },
  running_stride_length: { id: 144, unit: "cm" },

  // Activity — Swimming
  swimming_stroke_count: { id: 160, unit: "count" },
  underwater_depth: { id: 161, unit: "meters" },

  // Activity — Generic
  cadence: { id: 180, unit: "rpm" },
  power: { id: 181, unit: "watts" },
  speed: { id: 182, unit: "m_per_s" },
  workout_effort_score: { id: 183, unit: "score" },
  estimated_workout_effort_score: { id: 184, unit: "score" },

  // Environmental
  environmental_audio_exposure: { id: 200, unit: "dB" },
  headphone_audio_exposure: { id: 201, unit: "dB" },
  environmental_sound_reduction: { id: 202, unit: "dB" },
  time_in_daylight: { id: 203, unit: "minutes" },
  water_temperature: { id: 204, unit: "celsius" },
  uv_exposure: { id: 205, unit: "count" },
  inhaler_usage: { id: 206, unit: "count" },
  weather_temperature: { id: 207, unit: "celsius" },
  weather_humidity: { id: 208, unit: "percent" },

  // Garmin-Specific
  garmin_stress_level: { id: 220, unit: "score" },
  garmin_skin_temperature: { id: 221, unit: "celsius" },
  garmin_fitness_age: { id: 222, unit: "years" },
  garmin_body_battery: { id: 223, unit: "percent" },

  // Other
  electrodermal_activity: { id: 500, unit: "count" },
  push_count: { id: 501, unit: "count" },
  atrial_fibrillation_burden: { id: 502, unit: "count" },
  insulin_delivery: { id: 503, unit: "count" },
  number_of_times_fallen: { id: 504, unit: "count" },
  number_of_alcoholic_beverages: { id: 505, unit: "count" },
  nike_fuel: { id: 506, unit: "count" },
  hydration: { id: 507, unit: "mL" },
} as const;

export type SeriesType = keyof typeof SERIES_TYPES;
