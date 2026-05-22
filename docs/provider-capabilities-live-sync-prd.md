# Provider Capabilities and Live Sync Modes PRD

## Status

Draft.

## Source Signal

A reference implementation added a provider capability model and live sync mode semantics in April 2026, mainly around pull APIs, SDK push, webhook stream, webhook ping, webhook callback/backfill, and webhook registration.

## Problem

`convex-wearables` currently exposes provider support mostly through adapter presence and route registration. Host apps cannot reliably answer:

- whether a provider supports manual pull sync;
- whether live sync is webhook-only, SDK-only, or configurable;
- whether historical sync should call a REST API or trigger a provider backfill;
- whether a sync button should be shown;
- whether a provider requires webhook registration or a secret.

This creates app-specific conditionals in consumers such as `../clipin-app` and makes provider expansion riskier.

## Goals

- Add first-class provider capability metadata to every provider adapter.
- Export capability helpers from the public client package.
- Use capabilities inside sync workflow, route registration, and UI-facing status helpers.
- Keep existing provider credentials and route config backward-compatible.

## Non-Goals

- Do not implement new provider webhooks in this PRD.
- Do not remove existing sync APIs.
- Do not force host apps to adopt live sync configuration UI.

## Requirements

- Add a `ProviderCapabilities` type with flags:
  - `restPull`
  - `clientSdk`
  - `fileImport`
  - `webhookCallback`
  - `webhookStream`
  - `webhookPing`
  - `webhookRegistrationApi`
  - `webhookInboundSecret`
  - `maxHistoricalDays`
- Add `liveSyncConfigurable` and `defaultLiveSyncMode` derived helpers.
- Add provider-level capability definitions for Garmin, Strava, Whoop, Polar, Suunto, Apple, Samsung, and Google.
- Expose `getProviderCapabilities(provider)` from the package.
- Use capabilities to prevent manual sync for push-only providers unless a supported backfill path exists.

## Data Model

No required schema migration for a read-only capability map.

Optional later table:

```ts
providerSettings: {
  liveSyncMode?: "pull" | "webhook";
  webhookSecret?: string;
}
```

This optional change would be a schema migration because existing `providerSettings` rows would gain optional fields only.

## Public API

```ts
getProviderCapabilities(provider: ProviderName): ProviderCapabilities;
getLiveSyncMode(provider: ProviderName, configuredMode?: "pull" | "webhook"): "pull" | "webhook" | null;
```

## Existing User Impact

This should be a minor npm update if shipped as additive metadata and helpers.

`../clipin-app` impact:

- Can replace provider-specific sync button conditionals with capability checks.
- No required data migration.
- No app payload changes.
- If live sync mode is later persisted in `providerSettings`, the app should deploy the component schema before reading or writing the new optional fields.

Breaking risk:

- If existing manual sync APIs start rejecting currently accepted provider names, that is a behavior change. Ship warnings first, then enforce in a major release if needed.

## Versioning Guidance

Expected bump: minor (`0.3.0` while the package is pre-1.0).

Use a patch only if the implementation is limited to internal capability constants that are not exported and do not affect runtime behavior.

Use a major release, or the next pre-1.0 minor with a clear breaking-change note, if implementation:

- changes existing provider config shape;
- removes or renames existing public helpers;
- starts rejecting sync calls that previously succeeded;
- changes route registration defaults in a way that disables existing production routes.

Implementation considerations:

- Keep capability metadata additive and exported as optional helpers first.
- Update `../clipin-app` exhaustive provider logic before relying on capability-driven UI.
- Add tests proving current Garmin, SDK push, Strava, Whoop, Polar, and Suunto paths still behave as they did before capabilities are introduced.

## Rollout

1. Add types and provider metadata.
2. Add tests for each provider's derived mode.
3. Export helpers.
4. Update docs and `README`.
5. Optionally update `clipin-app` UI to consume capabilities.

## Open Questions

- Should host apps be able to override provider capabilities for private provider contracts?
- Should webhook registration status live in this component or in the host app?
