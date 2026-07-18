---
date: 2026-07-18
status: PROPOSED
priority: P2
semver: minor
owner_repo: convex-wearables
activation: partner-access-and-product-demand
---

# Ultrahuman Provider PRD

## Status

Proposed after partner API access and product demand are confirmed.

## Source Signal

A reference implementation added an Ultrahuman provider in March 2026 with OAuth, 24/7 data extraction, provider tests, and docs.

## What Is Ultrahuman?

Ultrahuman is a wearable and health platform best known for the Ultrahuman Ring. It exposes sleep, recovery, activity, and related continuous health metrics through partner APIs.

## Problem

`convex-wearables` does not currently support Ultrahuman. Apps that want ring-based recovery and sleep data need a separate integration or must route data through another source.

## Goals

- Add Ultrahuman as an optional OAuth provider.
- Normalize Ultrahuman sleep, recovery, activity, and body metrics into existing component tables.
- Reuse existing sync workflow and provider capability metadata.

## Non-Goals

- Do not add provider UI beyond exported metadata.
- Do not implement unsupported private APIs.
- Do not add raw payload storage unless the raw payload PRD is implemented.

## Requirements

- Add `"ultrahuman"` to `ProviderName` and schema validator.
- Add provider credentials support.
- Add `src/component/providers/ultrahuman.ts`.
- Register the provider in the provider registry.
- Normalize supported data into:
  - `events` for sleep/workouts if exposed;
  - `dataPoints` for recovery, HRV, resting heart rate, temperature, SpO2, and related metrics;
  - `dailySummaries` for daily activity, sleep, recovery, and body categories.
- Add tests using representative API payloads.

## Existing User Impact

This is a schema migration because `providerName` is a Convex validator union and adding `"ultrahuman"` changes accepted values.

Recommended npm versioning:

- Minor version if adding the provider is otherwise additive.
- Major version only if the public provider config shape changes.

`../clipin-app` impact:

- Must update package and deploy schema before using Ultrahuman.
- Existing users and data are unaffected.
- The app must add provider credentials and decide whether to expose the connection UI.
- If app code has exhaustive `ProviderName` switches, TypeScript will require updates.

## Versioning Guidance

Expected bump: minor (`0.3.0` or later pre-1.0 minor) because this adds a provider and expands the `ProviderName` union.

Use a major release, or the next pre-1.0 minor with explicit breaking notes, if implementation:

- changes `WearablesConfig.providers` shape;
- changes existing provider credential requirements;
- renames provider identifiers;
- changes existing provider normalization behavior while adding Ultrahuman.

Implementation considerations:

- Adding `"ultrahuman"` to Convex validators requires a schema deploy.
- TypeScript exhaustive provider switches in `../clipin-app` may fail compilation and should be updated intentionally.
- Keep Ultrahuman disabled unless credentials are configured.
- Add provider docs before exposing the connection option in production.

## Migration Plan

1. Add provider name to types and schema.
2. Add adapter and registry entry.
3. Add tests.
4. Document required credentials and scopes.
5. Enable in `clipin-app` behind a feature flag.

## Existing Consumer Upgrade Path

Adding `"ultrahuman"` widens `ProviderName` and the component schema validator;
it does not invalidate existing documents and requires no row migration. It can
break exhaustive TypeScript switches at compile time, which is desirable and
must be handled intentionally.

For `../clipin-app`: update the package, deploy the widened schema, resolve all
exhaustive provider switches, add credentials, then expose connection UI behind
a flag. Never configure or reference Ultrahuman before the schema deployment.

## Acceptance Criteria

- Representative partner fixtures cover sleep, recovery, activity, and body data.
- OAuth refresh/revocation follows structured lifecycle behavior.
- Units and timezone/date semantics are explicit and tested.
- Provider capability metadata reflects actual pull/webhook support.
- Existing providers and stored rows remain unchanged.

## Open Questions

- Which Ultrahuman API scopes are available to CLIPIN?
- Are webhooks available, or is Ultrahuman pull-only for launch?
