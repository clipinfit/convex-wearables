import type {
  LiveSyncMode,
  ProviderCapabilities,
  ProviderCapabilityInfo,
  ProviderName,
} from "./types.js";

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
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
    restPull: true,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: null,
  },
  polar: {
    restPull: true,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: null,
  },
  whoop: {
    restPull: true,
    clientSdk: false,
    fileImport: false,
    webhookCallback: false,
    webhookStream: false,
    webhookPing: false,
    webhookRegistrationApi: false,
    webhookInboundSecret: false,
    maxHistoricalDays: null,
  },
  strava: {
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
  if (merged.webhookStream && merged.webhookPing) {
    throw new Error("webhookStream and webhookPing are mutually exclusive");
  }
  if (merged.webhookPing && !merged.restPull) {
    throw new Error("webhookPing requires restPull because data must be fetched after the ping");
  }
  if (merged.webhookInboundSecret && !merged.webhookRegistrationApi) {
    throw new Error("webhookInboundSecret requires webhookRegistrationApi");
  }
  return merged;
}
