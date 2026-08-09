---
date: 2026-08-09
status: DEFERRED_ROADMAP
owner_repo: convex-wearables
activation: maintainer-decision-and-provider-access
---

# Wearable Provider Expansion Roadmap

## Status

This document records the recommended order for future wearable integrations.
It is not an active delivery plan and does not commit the project to starting,
shipping, or enabling any provider.

Provider APIs, approval requirements, scopes, and commercial terms can change.
Revalidate the official documentation and obtain any required access before
turning an item below into an implementation PRD.

## Current Coverage

The component currently has first-class cloud integrations for Garmin, Strava,
WHOOP, Polar, and Suunto. Apple Health, Samsung Health, and Google Health
Connect use normalized SDK push: the component accepts and stores data supplied
by a host mobile application, but it does not read those on-device stores by
itself. The Synthetic provider supplies deterministic test data.

This provides strong sports-watch coverage. The most material remaining gaps
are smart rings, Fitbit and Pixel devices, and connected health hardware such as
scales, blood-pressure monitors, thermometers, and sleep devices.

## Recommended Order

| Order | Provider or platform | Proposed delivery mode | Decision |
|---|---|---|---|
| 1 | Oura | OAuth pull, historical sync, and signed webhook-triggered fetch | Best next provider when expansion resumes. It fills the largest mainstream ring gap and maps cleanly to existing sleep, workout, summary, and time-series storage. |
| 2 | Google Health API | Google OAuth, REST pull, reconciled source-aware reads, and webhooks | Strategic platform integration for Fitbit, Pixel Watch, and supported third-party sources. Begin with an architecture spike because the existing `google` provider means Health Connect SDK push. |
| 3 | Withings | OAuth pull, historical sync, and notification-triggered fetch | Adds materially different coverage: watches, scales, blood pressure, sleep hardware, body composition, temperature, and ECG-capable devices. |
| 4 | Huawei Health | Prefer direct cloud integration; retain normalized SDK push as fallback | Feasible but approval-gated and likely to require an extension to the current one-stage OAuth lifecycle. Activate only after an access and authorization spike succeeds. |
| 5 | Ultrahuman | Partner OAuth and pull; webhooks only if available under granted access | Valuable second ring and recovery provider. Keep demand-driven until partner API access and usable scopes are confirmed. |
| 6 | COROS and Wahoo | Approved OAuth cloud integrations | Useful direct endurance coverage, but narrower than the providers above and dependent on provider approval. Implement independently according to demonstrated demand and granted access. |
| Bridge coverage | Amazfit/Zepp and Xiaomi/Mi Fitness | Health Connect or HealthKit SDK push | Do not use private or reverse-engineered cloud APIs. Treat these as mobile-bridge sources unless a stable, supported multi-user cloud API becomes available. |

## Delivery Phases

### Phase 0: Access and Contract Validation

Before implementation work begins:

1. Confirm that the provider accepts the intended open-source component and
   consumer use cases.
2. Obtain development credentials, representative fixtures, required scopes,
   applicable webhook secrets, and test accounts or devices.
3. Record approval thresholds, rate limits, historical limits, deletion or
   deregistration APIs, and terms that affect stored or redistributed data.
4. Decide whether the provider is suitable for a reusable component rather than
   only for one consuming application.

Access work may run ahead of implementation because provider review can take
longer than adapter development. Access does not activate a roadmap item by
itself.

### Phase 1: Oura

Create a dedicated PRD before changing the provider union or schema. The MVP
should cover:

- OAuth connection, refresh, revocation, and provider deregistration;
- one bounded historical import followed by webhook-triggered reconciliation;
- sleep sessions and stages;
- workouts;
- heart rate and HRV with explicit metric semantics;
- activity, sleep, readiness, stress, temperature, and SpO2 values that fit the
  existing normalized model; and
- provider fixtures covering timezone boundaries, naps, missing contributors,
  updates, deletes, and webhook replay.

Oura scores should be stored as provider observations. Adding a first-class
cross-provider scoring model remains outside this integration.

### Phase 2: Google Health API Architecture Spike

Do not implement a new legacy Fitbit Web API adapter from scratch. Google
describes the Google Health API as the next generation of that API, so new work
should target the Google Health API unless access or migration constraints prove
that impractical.

The spike must resolve these issues before a provider PRD is approved:

- **Provider identity:** preserve the existing `google` identifier, which means
  Health Connect SDK push. Prefer an additive cloud identifier such as
  `google_health`; do not silently give `google` two transport semantics.
- **Source provenance:** Google Health can return reconciled streams from
  Fitbit, Pixel Watch, and other source families. Preserve integration provider,
  original writer, source family, and device information through the existing
  source-aware model.
- **OAuth configuration:** determine whether the current provider credential
  shape is sufficient for Google OAuth scopes and verification requirements.
- **Webhook lifecycle:** define subscription registration, renewal, receipt,
  targeted fetch, replay, and deletion behavior using the durable provider
  webhook infrastructure.
- **Fitbit migration semantics:** document whether legacy Fitbit identities or
  data identifiers appear and how they affect deduplication and reconnection.

### Phase 3: Withings

Create the Withings PRD after deciding how far the provider-neutral model should
extend beyond activity and recovery. The first release should prefer metrics
already represented by the component. New clinical or waveform-like data must
not be forced into unsuitable scalar series merely to maximize endpoint
coverage.

An MVP can include activity, workouts, sleep, heart rate, weight, body
composition, blood pressure, temperature, and supported daily summaries.
Raw ECG or other high-volume waveform storage requires a separate data-model,
privacy, retention, and query decision.

### Phase 4: Gated Providers

Huawei, Ultrahuman, COROS, and Wahoo remain gated by access plus a concrete
consumer requirement:

- Huawei follows the existing
  [Huawei integration plan](./huawei-health-integration-plan.md), including its
  direct-cloud spike and SDK-push fallback.
- Ultrahuman follows the existing
  [Ultrahuman provider PRD](./ultrahuman-provider-prd.md).
- COROS and Wahoo each require a provider-specific access and coverage brief
  before a full PRD. They should not be combined into one adapter or release
  merely because both serve endurance users.

## Explicit Non-Goals

- Do not count an unsupported private API, scraped endpoint, or token captured
  from a consumer application as an integration path.
- Do not add a provider only to increase the provider count when Health Connect
  or HealthKit already supplies adequate, attributable bridge coverage.
- Do not choose a canonical record across direct providers and mobile health
  stores. Cross-provider reconciliation remains consumer-owned.
- Do not make a consuming application's roadmap, adoption timing, or UI work a
  release gate for this independent component.
- Do not expand into regulated interpretation, diagnosis, or provider-neutral
  health scoring as an incidental part of adding a device provider.

## Activation Criteria

A maintainer may promote an item from this roadmap into an active PRD only when:

1. official and permitted API access is confirmed;
2. representative data and at least one end-to-end test account are available;
3. the provider contributes meaningful coverage not adequately supplied by an
   existing integration or SDK bridge;
4. authentication, sync, webhook, rate-limit, lifecycle, and deletion behavior
   are understood;
5. normalization and source-provenance semantics are explicit; and
6. schema, semantic-versioning, deployment, rollback, and generic consumer
   upgrade effects are documented.

Every new provider is expected to be an additive minor release unless its final
design changes an existing public identifier, configuration contract, schema
meaning, or runtime behavior. Widening `ProviderName` and Convex validators still
requires a schema deployment and can intentionally reveal exhaustive TypeScript
switches in consumers.

## Official References Reviewed

These references supported the ordering as of the document date and must be
rechecked when an item is activated:

- [Oura API V2](https://cloud.ouraring.com/v2/docs)
- [Google Health API](https://developers.google.com/health)
- [Google Health API migration specifications](https://developers.google.com/health/migration/api-specifications)
- [Withings Public API](https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/public-health-data-api-overview/)
- [Withings available health data](https://developer.withings.com/developer-guide/v3/integration-guide/surveys/data-api/all-available-health-data/)
- [Huawei Health Kit](https://developer.huawei.com/consumer/en/hms/huaweihealth/)
- [COROS API application](https://support.coros.com/hc/en-us/articles/17085887816340-Submitting-an-API-Application)
- [Wahoo Cloud API](https://developers.wahooligan.com/cloud)
