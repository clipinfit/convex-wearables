import type {
  LiveSyncMode,
  ProviderCapabilities,
  ProviderCapabilityInfo,
  ProviderName,
} from "./types.js";

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  generated: false,
  restPull: false,
  clientSdk: false,
  fileImport: false,
  webhookCallback: false,
  webhookStream: false,
  webhookPing: false,
  webhookRegistrationApi: false,
  webhookInboundSecret: false,
  maxHistoricalDays: null,
};

const PROVIDER_CAPABILITIES = {
  garmin: {
    generated: false,
    restPull: false,
    clientSdk: false,
    fileImport: false,
    webhookCallback: true,
    webhookStream: true,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: 30,
  },
  suunto: {
    generated: false,
    restPull: true,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: true,
    webhookPing: true,
    webhookRegistrationApi: false,
    webhookInboundSecret: true,
    maxHistoricalDays: null,
  },
  polar: {
    generated: false,
    restPull: true,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: true,
    webhookRegistrationApi: true,
    webhookInboundSecret: true,
    maxHistoricalDays: null,
  },
  whoop: {
    generated: false,
    restPull: true,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: true,
    webhookRegistrationApi: false,
    webhookInboundSecret: true,
    maxHistoricalDays: null,
  },
  strava: {
    generated: false,
    restPull: true,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: true,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: null,
  },
  apple: {
    generated: false,
    restPull: false,
    clientSdk: true,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: null,
  },
  samsung: {
    generated: false,
    restPull: false,
    clientSdk: true,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: null,
  },
  google: {
    generated: false,
    restPull: false,
    clientSdk: true,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: null,
  },
  synthetic: {
    generated: true,
    restPull: false,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: 31,
  },
} satisfies Record<ProviderName, ProviderCapabilities>;

export const PROVIDER_NAMES = Object.keys(PROVIDER_CAPABILITIES) as ProviderName[];

export function getProviderCapabilities(provider: ProviderName): ProviderCapabilities {
  return { ...PROVIDER_CAPABILITIES[provider] };
}

export function getProviderCapabilityInfo(provider: ProviderName): ProviderCapabilityInfo {
  const capabilities = getProviderCapabilities(provider);
  return {
    provider,
    ...capabilities,
    implemented: true,
    liveSyncConfigurable: isLiveSyncConfigurable(capabilities),
    defaultLiveSyncMode: getDefaultLiveSyncMode(provider),
    supportsManualSync: supportsManualSync(provider),
    supportsHistoricalSync: supportsHistoricalSync(provider),
    supportsBackfill: supportsBackfill(provider),
  };
}

export function getAllProviderCapabilityInfo(): ProviderCapabilityInfo[] {
  return PROVIDER_NAMES.map((provider) => getProviderCapabilityInfo(provider));
}

export function getDefaultLiveSyncMode(provider: ProviderName): LiveSyncMode | null {
  const capabilities = getProviderCapabilities(provider);
  if (capabilities.restPull) return "pull";
  if (capabilities.clientSdk) return null;
  if (capabilities.webhookStream || capabilities.webhookPing) return "webhook";
  return null;
}

export function isLiveSyncConfigurable(
  providerOrCapabilities: ProviderName | ProviderCapabilities,
): boolean {
  const capabilities =
    typeof providerOrCapabilities === "string"
      ? getProviderCapabilities(providerOrCapabilities)
      : providerOrCapabilities;
  return capabilities.restPull && (capabilities.webhookStream || capabilities.webhookPing);
}

export function supportsManualSync(provider: ProviderName): boolean {
  const capabilities = getProviderCapabilities(provider);
  return capabilities.restPull;
}

export function supportsHistoricalSync(provider: ProviderName): boolean {
  const capabilities = getProviderCapabilities(provider);
  return capabilities.restPull || capabilities.webhookCallback;
}

export function supportsBackfill(provider: ProviderName): boolean {
  const capabilities = getProviderCapabilities(provider);
  return capabilities.webhookCallback;
}

export function createProviderCapabilities(
  capabilities: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  const merged = { ...DEFAULT_CAPABILITIES, ...capabilities };
  if (merged.webhookPing && !merged.restPull) {
    throw new Error("webhookPing requires restPull because data must be fetched after the ping");
  }
  return merged;
}
