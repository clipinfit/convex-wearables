/**
 * Provider registry — maps provider names to their OAuth configs and data fetchers.
 */

import type { ProviderAdapter } from "./types";
import { stravaProvider } from "./strava";
import { garminProvider } from "./garmin";
import { polarProvider } from "./polar";
import { whoopProvider } from "./whoop";
import { suuntoProvider } from "./suunto";

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

const PROVIDERS: Record<string, ProviderAdapter> = {
  strava: stravaProvider,
  garmin: garminProvider,
  polar: polarProvider,
  whoop: whoopProvider,
  suunto: suuntoProvider,
};

/**
 * Get the provider definition for a given provider name.
 * Returns undefined if the provider is not yet implemented.
 */
export function getProvider(name: string): ProviderAdapter | undefined {
  return PROVIDERS[name];
}

/**
 * Get all implemented provider names.
 */
export function getImplementedProviders(): string[] {
  return Object.keys(PROVIDERS);
}
