---
date: 2026-04-19
status: NOT_IMPLEMENTED
semver: minor
---

# Huawei Health / Huawei Watches Integration Plan for `convex-wearables`

## Summary
- Huawei watch support appears feasible, but the real integration target is HUAWEI Health Kit and Huawei Health app data, not the watch hardware directly.
- Huawei documents both cloud REST APIs and client-side SDK flows, which gives this component two realistic implementation paths:
  - a direct first-class `huawei` provider using OAuth + REST sync
  - a normalized SDK-push path, similar to Apple Health, Samsung Health, and Google Health Connect
- The direct provider path is the better long-term fit for this repo, but it has materially higher delivery risk because Huawei adds approval gates, Health Kit scope review, and a second Huawei Health app authorization step after OAuth.
- Recommendation: treat this as a staged project with an early technical spike and a fallback path, not as a simple adapter drop-in.

## Feasibility Conclusion
- Yes, a Huawei integration looks possible in principle.
- Huawei's official docs explicitly describe:
  - HUAWEI ID OAuth 2.0 authorization code flow for server-side access
  - `access_type=offline` refresh-token support
  - cloud-side REST APIs for web and mobile apps
  - open data types that overlap well with this component's normalized model: workouts, sleep, heart rate, steps, calories, distance, stress, SpO2, body temperature, and daily/historical summaries
- The main uncertainty is not whether Huawei exposes data. The real uncertainty is whether Clipin can complete the required Huawei onboarding and verification path quickly enough, and whether the extra Huawei Health app linking flow works cleanly with the current OAuth lifecycle in this component.

## Why This Is Not a Normal Provider Addition
- The current first-class providers are registry-driven adapters in `src/component/providers/*`, registered through [src/component/providers/registry.ts](/Users/denis/git/clipin/convex-wearables/src/component/providers/registry.ts).
- The current normalized SDK-push path is implemented in [src/component/sdkPush.ts](/Users/denis/git/clipin/convex-wearables/src/component/sdkPush.ts) and currently covers Apple, Samsung, and Google.
- The current OAuth lifecycle in [src/component/oauthActions.ts](/Users/denis/git/clipin/convex-wearables/src/component/oauthActions.ts) assumes:
  - one authorization redirect
  - one token exchange
  - optional non-interactive `postConnect`
  - immediate connection activation
- Huawei appears to require one more user-facing step after token exchange when the goal is access to Huawei Health app data from watches:
  - OAuth code exchange
  - then a separate Huawei Health app authorization/link flow
  - then a callback carrying `privacyLink_code=0` and `open_id`
- That means Huawei likely needs an auth lifecycle extension, not just a new `ProviderAdapter`.

## What "Huawei Watch Support" Means in Practice
- For this component, "Huawei watch support" should be defined as: sync data that Huawei watches publish into Huawei Health / Health Kit into the existing Convex tables.
- We should not design around direct watch transport, BLE, or device-side pairing inside this repo.
- The repo already normalizes data into `connections`, `dataSources`, `events`, `dataPoints`, and `dailySummaries`.
- Huawei should plug into those same tables through one of two modes:
  - direct cloud provider sync into the existing provider workflow
  - mobile SDK bridge that posts normalized payloads into the existing SDK sync route

## Official Huawei Findings

### Access surfaces
- Huawei's Health Kit overview says Health Kit provides Java APIs, Cloud APIs, JavaScript APIs, and device access.
- Huawei's "App-oriented Open Services" guide says the cloud-side open capabilities support both web apps and mobile apps.
- The same guide says REST APIs are recommended for cross-platform development across Android, iOS, web, and mini-program style surfaces.

### Onboarding and approval gates
- Huawei's getting-started flow requires:
  - applying for HUAWEI ID service
  - applying for Health Service Kit scopes
  - developing and testing
  - then applying for verification
- The Health Service Kit application guide says test-scope review takes about 15 workdays.
- The same guide says only the first 100 users can use the app during the test phase until verification is completed.
- The same guide says testing should begin 24 hours after test scopes are granted because of data caching.
- The verification guide says formal verification also takes about 15 working days and requires privacy, authorization cancellation, partial authorization, and Huawei Health privacy-switch handling to behave correctly.

### OAuth and Huawei Health app linking
- Huawei documents an OAuth authorization endpoint at [oauth-login.cloud.huawei.com/oauth2/v3/authorize](https://oauth-login.cloud.huawei.com/oauth2/v3/authorize).
- Huawei documents a token endpoint at [oauth-login.cloud.huawei.com/oauth2/v3/token](https://oauth-login.cloud.huawei.com/oauth2/v3/token).
- Huawei documents `openid` as part of the requested scope set and documents `access_type=offline` for refresh-token issuance.
- Huawei also documents a token-info API through [oauth-api.cloud.huawei.com/rest.php?nsp_fmt=JSON&nsp_svc=huawei.oauth2.user.getTokenInfo](https://oauth-api.cloud.huawei.com/rest.php?nsp_fmt=JSON&nsp_svc=huawei.oauth2.user.getTokenInfo).
- Separately, Huawei documents a Huawei Health app authorization page at [h5hosting.dbankcdn.com/cch5/healthkit/privacy/link.html](https://h5hosting.dbankcdn.com/cch5/healthkit/privacy/link.html) that uses the OAuth access token and returns `privacyLink_code=0` plus `open_id` on success.
- This second step is the clearest sign that Huawei Health watch data access is not unlocked by plain OAuth alone.

### Data coverage and timeliness
- Huawei's open-data overview includes exercise record summary, exercise record detailed data, heart rate, sleep, stress, blood oxygen saturation, body temperature, and historical data.
- Huawei's "Data Openness of Huawei Wear and Health Apps" guide documents that server-side data timeliness varies by metric:
  - some metrics are available in about 10 minutes
  - some are delayed by hours
- The same guide documents minimum app and SDK versions for Huawei Health data access:
  - Huawei Health app 11.0.0.512 or later
  - Health Kit SDK 5.0.4.300 or later on the client side
- Huawei's exercise-record overview says:
  - workout summary access uses `HEALTHKIT_ACTIVITY_RECORD_READ`
  - detailed activity access uses `HEALTHKIT_ACTIVITY_READ`
  - exercise-record query timeliness is "in minutes"
  - data openness is not supported for exercise records created directly by users

## Product Goals
- Add a credible Huawei path without destabilizing the existing provider architecture.
- Support Huawei watch-originated activity through Huawei Health / Health Kit in the same normalized storage model used by other providers.
- Keep the first milestone focused on high-value data that already maps cleanly into this repo:
  - workouts
  - sleep
  - heart rate
  - activity summaries such as steps, calories, and distance
- Avoid betting the whole project on advanced or medically sensitive Huawei data types before basic connectivity is proven.

## Non-Goals for v1
- Do not attempt direct watch-device connectivity.
- Do not promise every Huawei Health data type on day one.
- Do not promise zero-latency sync; Huawei's own docs show hours-level delays for some cloud-side queries.
- Do not couple the first milestone to advanced openness data that may require enterprise-only approval.
- Do not redesign the existing normalized storage model just for Huawei.

## Integration Options

### Option A: Direct first-class `huawei` provider

#### What it looks like
- Add `"huawei"` to the provider unions in:
  - [src/component/schema.ts](/Users/denis/git/clipin/convex-wearables/src/component/schema.ts)
  - [src/client/types.ts](/Users/denis/git/clipin/convex-wearables/src/client/types.ts)
- Implement a new adapter in `src/component/providers/huawei.ts`.
- Register it in [src/component/providers/registry.ts](/Users/denis/git/clipin/convex-wearables/src/component/providers/registry.ts).
- Extend the auth flow so OAuth exchange can pause pending Huawei Health app linking before the connection is marked active.
- Use Huawei REST APIs to fetch workouts, time-series data, and daily summaries into the existing sync workflow.

#### Why this is the best architectural fit
- It keeps Huawei aligned with the existing provider model instead of treating it as a special mobile-only exception.
- It allows the host app to offer a first-class "Connect Huawei" flow similar to Garmin or Strava.
- It avoids requiring every product using this component to also ship a mobile Huawei bridge.

#### Why it is risky
- Huawei onboarding is slower and more manual than typical provider integrations.
- The current OAuth architecture does not yet model a "connected to OAuth but not yet linked to Huawei Health app" state.
- Data timeliness is weaker than some existing providers for several metrics.
- Approval constraints can block or delay rollout even if the code is correct.

### Option B: SDK-push Huawei bridge

#### What it looks like
- Extend the SDK-push provider union to include `"huawei"`.
- Keep Huawei ingestion inside [src/component/sdkPush.ts](/Users/denis/git/clipin/convex-wearables/src/component/sdkPush.ts).
- Use a Clipin mobile app to read Huawei Health / Health Kit data locally, normalize it, and POST it to the existing SDK sync route.

#### Why this is attractive
- It reuses the same ingestion path already used for Apple, Samsung, and Google.
- It avoids backend-side Huawei OAuth and reduces server-only complexity.
- It may be faster if Clipin already has a mobile app that can integrate Huawei SDKs.

#### Why it is a weaker product fit
- It is not a standalone cloud provider integration.
- It requires mobile engineering outside this repo.
- It makes Huawei support dependent on the presence and quality of a Clipin mobile bridge.

## Recommendation
- Preferred path: pursue a direct first-class `huawei` provider, but gate it behind a short spike that proves the auth and data-access path end to end.
- Fallback path: if Huawei review, verification, or Health app linking turns out to be too restrictive, add Huawei as another normalized SDK-push provider instead of forcing a fragile half-provider into the sync engine.
- Decision rule:
  - if the spike proves OAuth, refresh token issuance, Huawei Health app linking, and at least one successful REST data pull, continue with the direct provider
  - if any of those fail for policy or platform reasons, switch to SDK push without blocking Huawei support entirely

## Huawei Registration Prerequisites
- For the direct-provider path, Clipin should expect to register a Huawei server-side app, not just a mobile app.
- Huawei's HUAWEI ID service guide documents different registration requirements depending on app type:
  - `Server app` or web-style setup for backend OAuth and REST access
  - `Mobile app` setup for SDK-based device/app integration
- For the direct-provider path, the project should budget for:
  - callback URL registration for the OAuth redirect
  - app access URL / server egress IP registration where Huawei requires it
  - explicit scope application for the minimum Huawei Health permissions
- If the fallback becomes SDK push, the project should also expect mobile-app registration details such as package name and SHA-256 fingerprinting.
- This registration work should be treated as part of Phase 0, not as a small deployment detail after coding.

## Recommended MVP Scope

| Capability | Huawei scope area | Component destination | Recommendation |
|----------|--------------------|-----------------------|----------------|
| Connection and identity | `openid` plus Huawei Health scopes | `connections` | Required |
| Activity summaries | step, calories, distance style scopes | `dailySummaries` category `activity` | Required |
| Heart rate | `heartrate.read` | `dataPoints` and summary stats | Required |
| Sleep | `sleep.read` | `events` category `sleep` and `dailySummaries` category `sleep` | Required |
| Workouts | `activityrecord.read` and possibly `activity.read` | `events` category `workout` | Required |
| SpO2 / stress / temperature | corresponding per-metric read scopes | `dataPoints` and selective summaries | Phase 2 |
| Body and clinical-style metrics | weight, blood pressure, glucose, etc. | mixed | Defer until approval scope is clearer |

### Scope strategy
- Start with the minimum Huawei scopes needed to prove the main wearable value.
- Do not request advanced or sensitive scopes in the first approval round unless the product truly needs them.
- The docs explicitly push least-privilege scope applications, so the MVP should stay narrow:
  - workouts
  - sleep
  - heart rate
  - steps/calories/distance summaries

## Proposed Auth Flow for the Direct Provider

### Current component constraint
- Today, `handleCallback` exchanges the code and immediately creates an active connection.
- That is probably too early for Huawei.

### Proposed Huawei flow
1. User starts OAuth through the existing `generateAuthUrl` path.
2. Huawei redirects back with `state` and `code`.
3. Component exchanges the code for access and refresh tokens.
4. Instead of immediately activating the connection, the component stores a pending Huawei setup record.
5. The host app redirects the user to Huawei's Health app authorization page using the access token.
6. Huawei redirects back with `privacyLink_code` and `open_id`.
7. Component finalizes the connection:
   - set provider to `huawei`
   - store tokens
   - store `providerUserId` as the stable Huawei identifier, most likely `open_id`
   - mark the connection active
   - create the default `dataSource`

### New state needed in this repo
- Either add a new ephemeral table such as `pendingProviderConnections`, or extend existing OAuth state handling with a second-stage setup record.
- Add a callback path or finish-action specifically for Huawei Health linking.
- Consider adding a transient connection status such as `pending_setup` if we want partially completed Huawei connections to be visible in the main `connections` table.

### Why `postConnect` is not enough
- `postConnect` in the current provider contract is non-interactive.
- Huawei Health app linking is user-facing and redirect-based.
- That means the current provider contract is insufficient by itself for Huawei and will need a small auth-framework extension.

## Data Mapping Plan

### Workouts
- Use Huawei exercise record summary as the first workout ingestion surface.
- Map each Huawei workout into the existing `events` table with:
  - `category: "workout"`
  - normalized `type`
  - start and end timestamps
  - duration
  - distance, calories, heart rate summary, and other existing workout fields when available
- Treat detailed workout samples as optional later enrichment.
- Do not promise manual workouts entered directly by users in Huawei Health, because Huawei says data openness does not cover all exercise records created directly by users.

### Sleep
- Map Huawei sleep sessions into `events` category `sleep`.
- When stage data is available, map it into the existing `sleepStages` structure.
- Also derive `dailySummaries` sleep aggregates using the same pattern already used by other providers.

### Time series
- Start with heart rate as the first Huawei time-series metric.
- Add SpO2, stress, and temperature later if their response shapes and timeliness are acceptable.
- Respect Huawei's timeliness constraints in sync UX and documentation.

### Daily summaries
- Populate `dailySummaries` for activity and sleep first.
- Use Huawei's daily or historical summary endpoints where available rather than reconstructing everything from raw samples.

## Repo Changes Required for the Direct Provider

### Public types and schema
- Add `"huawei"` to provider unions in:
  - [src/component/schema.ts](/Users/denis/git/clipin/convex-wearables/src/component/schema.ts)
  - [src/client/types.ts](/Users/denis/git/clipin/convex-wearables/src/client/types.ts)
  - any validators, docs, and README provider tables that hardcode supported providers

### Provider implementation
- Add `src/component/providers/huawei.ts` implementing:
  - `oauthConfig`
  - `getUserInfo`
  - `fetchEvents`
  - `fetchDataPoints`
  - `fetchDailySummaries`
- Register the adapter in [src/component/providers/registry.ts](/Users/denis/git/clipin/convex-wearables/src/component/providers/registry.ts).
- Reuse [src/component/providers/oauth.ts](/Users/denis/git/clipin/convex-wearables/src/component/providers/oauth.ts) for token exchange and refresh where possible.

### Auth lifecycle extension
- Update [src/component/oauthActions.ts](/Users/denis/git/clipin/convex-wearables/src/component/oauthActions.ts) to support staged completion for providers that need an extra post-token redirect.
- Update [src/component/httpHandlers.ts](/Users/denis/git/clipin/convex-wearables/src/component/httpHandlers.ts) or add a new handler for Huawei Health app linking callbacks.
- Decide whether `providerUserId` should be assigned only after health-link completion.

### Sync and tests
- Wire Huawei into the existing sync workflow once the adapter is complete.
- Add adapter, OAuth, and sync tests similar to the current provider test suite.
- Add regression tests for:
  - partial authorization
  - revoked authorization
  - missing health-link completion
  - hours-delayed data responses

## Repo Changes Required for the SDK-Push Fallback
- Add `"huawei"` to `SdkProviderName` in [src/client/types.ts](/Users/denis/git/clipin/convex-wearables/src/client/types.ts).
- Extend the SDK validator union in [src/component/sdkPush.ts](/Users/denis/git/clipin/convex-wearables/src/component/sdkPush.ts).
- Add a default source name such as `Huawei Health`.
- Update README provider tables and SDK route docs.
- Keep backend storage unchanged; the normalized payload shape already fits Huawei-originated workouts, sleep, data points, and summaries.

## Technical Spike Plan

### Goal
- Prove whether a direct Huawei provider is viable before committing to a full implementation.

### Exit criteria
- Register a Huawei app and apply for the minimum scopes needed for MVP.
- Complete end-to-end OAuth authorization code flow.
- Confirm refresh-token issuance through `access_type=offline`.
- Complete Huawei Health app linking and receive a successful callback containing `privacyLink_code=0`.
- Resolve a stable user identifier such as `open_id`.
- Successfully read at least:
  - one workout
  - one sleep record or sleep summary
  - one heart-rate or activity summary payload
- Map those responses into this component's normalized event/data-point/summary shapes.

### Deliverables
- A short spike report documenting:
  - exact Huawei endpoints used
  - actual response examples
  - scope-to-field mapping
  - any policy blockers
  - whether direct provider or SDK push should proceed

## Delivery Phases

### Phase 0: Approval and spike
- Create the Huawei app registration.
- Apply for HUAWEI ID service and Health Service Kit scopes.
- Run the end-to-end auth and data-access spike.
- Make the go/no-go decision for direct provider vs SDK push.

### Phase 1: Direct-provider auth skeleton
- Add `"huawei"` as a supported provider.
- Implement OAuth config, token exchange, refresh, and staged Huawei Health linking.
- Finalize connection creation only after successful health-link completion.

### Phase 2: MVP sync
- Implement workouts, sleep, heart rate, and activity summary ingestion.
- Add tests and docs.
- Validate behavior against Huawei's documented data delays.

### Phase 3: Expansion
- Add more metrics such as SpO2, stress, and temperature if they are stable and useful.
- Revisit detailed workout streams only after summary-level ingestion is reliable.

## Risks and Open Questions
- Huawei review and verification timelines may dominate engineering time.
- Huawei's test phase user cap of 100 users makes broad beta rollout impossible before verification.
- Some Huawei data categories may require enterprise-level eligibility.
- The current component auth model does not yet support a second redirect-based completion step.
- We still need the exact Huawei REST endpoint inventory and response shapes for the specific data types we want.
- Some cloud-side Huawei data is delayed by hours, which can make the sync experience feel stale if the UI promises near-real-time values.
- Workout openness is not equivalent to "every workout in the Huawei app"; manual entries and some detail cases may remain unavailable.

## Verification and QA Plan
- Unit test Huawei mapping logic with recorded fixture responses.
- Add OAuth-path tests for:
  - successful staged setup
  - missing `open_id`
  - canceled health-link flow
  - refresh-token renewal
- Add sync integration tests for workouts, sleep, daily summaries, and heart-rate data points.
- Run manual QA with:
  - a Huawei account
  - a Huawei watch
  - Huawei Health app on a supported phone
  - revoked permissions
  - partial-scope grants
  - Huawei Health privacy switch disabled

## Documentation Checklist

### Core product and access model
- [About HUAWEI Health Kit](https://developer.huawei.com/consumer/en/doc/health-introduce-0000001053684429-V5)
- [App-oriented Open Services](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/application_description-0000001418052318)

### Onboarding and approval
- [Getting Started](https://developer.huawei.com/consumer/en/doc/development/HMSCore-Guides/dev-process-0000001050166278)
- [Applying for the HUAWEI ID Service](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/apply-id-0000001050069756)
- [Applying for Health Service Kit](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/apply-kitservice-0000001050071707)
- [Applying for Verification](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/verification-0000001211587947)

### OAuth, authorization, and scopes
- [Authentication and Authorization Example](https://developer.huawei.com/consumer/en/doc/development/HMSCore-Guides-V5/auth-example-0000001054581058-V5)
- [Example of the Health App Authorization](https://developer.huawei.com/consumer/en/doc/development/HMSCore-Guides-V5/server-app-auth-example-0000001071757151-V5)
- [Scopes Reference](https://developer.huawei.com/consumer/en/doc/HMSCore-References/scopes-0000001050092713)

### Data model and per-type validation
- [Open Data Overview](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/data_description-0000001467889369)
- [Data Openness of Huawei Wear and Health Apps](https://developer.huawei.com/consumer/en/doc/development/HMSCore-Guides-V5/read-sport-health-datatype-0000001059873166-V5)
- [Exercise Record Overview](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/activity-type-constants-0000001135051290)

### If we pursue the SDK-push fallback
- [Obtaining User Authorization](https://developer.huawei.com/consumer/en/doc/HMSCore-Guides/add-permissions-0000001050069726)

## Final Recommendation
- Huawei support is worth pursuing, but only with an explicit spike and fallback plan.
- The best target for this repo is a direct `huawei` provider if Huawei's auth and approval flow can be proven in practice.
- The safest delivery strategy is:
  - spike first
  - direct provider if the spike succeeds
  - SDK-push fallback if Huawei's process or browser-linking model blocks a clean first-class provider
