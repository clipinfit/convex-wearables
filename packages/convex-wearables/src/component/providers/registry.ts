/**
 * Provider registry — maps provider names to their OAuth configs and data fetchers.
 */

import { garminProvider } from "./garmin";
import { polarProvider } from "./polar";
import { stravaProvider } from "./strava";
import { suuntoProvider } from "./suunto";
import type { ProviderAdapter } from "./types";
import { whoopProvider } from "./whoop";

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
