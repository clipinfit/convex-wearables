---
date: 2026-07-18
status: PLANNED
priority: P2
semver: minor
owner_repo: convex-wearables
depends_on: outgoing-webhooks-prd
---

# Polar, Suunto, and Whoop Live Webhooks PRD

## Status

Planned after the generic outgoing event boundary.

## Source Signal

A reference implementation added Suunto webhook handling, a substantial Polar refactor with webhook registration and secret handling, and Whoop incoming workout/sleep/recovery handlers.

## Problem

`convex-wearables` has Polar, Suunto, and Whoop pull adapters, but live sync behavior is incomplete compared with the target provider behavior. Users relying on these providers may see delayed data until the next manual or scheduled sync.

## Goals

- Add Suunto live webhook ingestion where provider contracts allow it.
- Add Polar webhook registration and inbound verification.
- Add Whoop workout, sleep, and recovery webhook ingestion.
- Reuse the provider capability model for UI and sync decisions.
- Preserve existing pull sync as fallback.

## Non-Goals

- Do not remove pull sync for Polar or Suunto.
- Do not implement a dashboard UI in the component package.
- Do not store provider webhook secrets in host app tables.

## Requirements

- Add route config for Polar, Suunto, and Whoop webhook endpoints.
- Add provider settings fields if required:
  - `webhookSecret?: string`
  - `liveSyncMode?: "pull" | "webhook"`
- Add webhook handlers that:
  - validate provider signatures or secrets;
  - resolve provider user to a component connection;
  - fetch follow-up data when the webhook is a ping;
  - write normalized events, points, and summaries.
- Add tests for valid, invalid, duplicate, and unknown-user payloads.

## Existing User Impact

Schema migration may be required if webhook secrets or live sync mode are stored in `providerSettings`.

Recommended npm versioning:

- Minor version if routes and settings fields are optional.
- Major version if provider settings config shape changes incompatibly.

`../clipin-app` impact:

- Must update route registration if the app wants Polar/Suunto webhooks exposed.
- Must deploy schema before enabling provider-managed webhook secrets.
- Existing pull-based behavior should continue to work if routes are not registered.
- Production rollout should keep pull sync fallback enabled until webhook reliability is verified.

## Versioning Guidance

Expected bump: minor (`0.3.0` or later pre-1.0 minor) if webhook routes are optional and pull sync remains unchanged.

Use a major release, or the next pre-1.0 minor with explicit breaking notes, if implementation:

- changes provider credentials shape;
- makes webhook registration mandatory for Polar or Suunto;
- disables existing pull sync defaults;
- changes provider settings schema in a non-optional way.

Implementation considerations:

- Provider webhook secrets require a schema deploy if stored in `providerSettings`.
- Keep route registration opt-in so existing apps do not expose new HTTP endpoints unexpectedly.
- Add replay/duplicate handling before enabling production webhooks.
- `../clipin-app` should enable one provider at a time behind a feature flag and monitor parity against pull sync.

## Migration Plan

1. Add optional schema fields.
2. Add route registration options disabled by default.
3. Add handlers and tests.
4. Add a manual registration action for provider webhooks.
5. Enable per provider in `clipin-app` only after provider credentials and callback URLs are configured.

## Existing Consumer Upgrade Path

Expected schema changes are optional fields on `providerSettings` or an
additive provider-webhook registration table. No existing health-data row needs
rewriting. If an index is added to the existing settings table, stage it before
query use.

`../clipin-app` currently configures only Garmin, so package/schema deployment
does not require route or environment changes there. When CLIPIN enables one of
these providers it must, in order:

1. update and deploy the component schema;
2. configure provider credentials and signing/verification secrets;
3. mount only that provider's routes;
4. register/verify the provider subscription;
5. retain pull sync as fallback during parity measurement; and
6. switch the capability metadata/live mode only after monitored success.

## Acceptance Criteria

- Invalid signatures/secrets fail closed without logging secret material.
- Webhook receipt is acknowledged after durable scheduling, not full ingest.
- Duplicate, reordered, and unknown-user notifications are safe.
- Permanent provider/delivery 4xx failures are not retried forever.
- Pull fallback remains available until explicitly disabled.
- Capability metadata matches the routes and handlers actually enabled.

## Open Questions

- Which provider webhook subscriptions can be registered programmatically from Convex actions?
- Should the component renew webhook registrations automatically with cron jobs?
