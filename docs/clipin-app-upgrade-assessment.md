---
date: 2026-07-18
status: CURRENT_ASSESSMENT
consumer_repo: ../clipin-app
consumer_revision: 3577953d81e5fcd846ea24ac2c49e93e37e8e6fa
installed_version: 0.6.0
---

# `clipin-app` Upgrade Assessment

## Current integration

At the assessed revision, `../clipin-app`:

- pins `@clipin/convex-wearables` to published version `0.6.0`;
- mounts the component in `packages/backend/convex/convex.config.ts`;
- constructs `WearablesClient` with Garmin credentials and optional Synthetic;
- mounts Garmin push/health routes through `registerRoutes`;
- does not mount the exported Strava webhook handlers;
- uses a 24-hour pull sync window for future pull-capable providers;
- uses a 30-day Garmin initial backfill; and
- wraps component functions behind CLIPIN-owned authenticated functions.

No file in `../clipin-app` is changed by the current local implementation, and
its dependency remains `0.6.0`. No package is published by this work.

## Upgrade path for the local reliability tranche

After an operator later publishes a release containing the local changes:

1. Update `packages/backend/package.json` and the registry lockfile through the
   normal CLIPIN dependency workflow.
2. Install the published package; do not use a persistent local `file:`,
   `link:`, or workspace resolution for production.
3. Run CLIPIN's native-health dependency verifier.
4. Run backend typecheck/tests and deploy Convex.
5. No component migration command is needed because the schema is unchanged.
6. Verify a Garmin webhook containing blood pressure and respiration data.
7. Verify revoked/expired connection states in the existing reconnect flow.

CLIPIN does not need `STRAVA_WEBHOOK_VERIFY_TOKEN` today because it does not
mount the Strava handler. Add that secret before enabling Strava webhooks.

Pull lookback is optional. The current app can adopt it later by adding, for
example:

```ts
export const wearablesClient = new WearablesClient(components.wearables, {
  providers: getConfiguredProviders(),
  pullSyncLookbackHours: {
    whoop: 24,
    polar: 12,
    suunto: 12,
    strava: 6,
  },
});
```

Garmin is push-based in this component, so pull lookback does not affect its
current CLIPIN integration. Enabling lookback increases provider API reads and
should be chosen per provider rather than applied blindly.

## Data migration classification

| Change | Schema deploy | Host-run migration | Existing data risk |
|---|---|---|---|
| Garmin timestamp/respiration aliases | No schema diff | None | New payloads stop being dropped; old rows unchanged. |
| Structured provider errors | No schema diff | None | Existing status enum reused. |
| Refresh rejection becomes `revoked` | No schema diff | None | Future lifecycle behavior changes; reconnect UI must already handle `revoked`. |
| Missing refresh token becomes `expired` | No schema diff | None | Future lifecycle behavior changes only. |
| Pull lookback | No schema diff | None | Optional extra provider reads and idempotent updates. |
| Strava verification secret | No schema diff | Environment change only when route is mounted | Route fails closed if misconfigured. |

## Future-work upgrade categories

- Additive-table releases: update package, deploy schema, then adopt APIs. No
  historical rewrite unless the PRD explicitly offers an optional backfill.
- Provider-union releases: deploy schema before configuring the new provider;
  fix exhaustive TypeScript switches during the package update.
- Optional backfills: run only after the compatibility deploy, monitor to
  completion, and keep old reads until verified.
- Retention releases: deploy in retain-forever mode; preview and approve finite
  deletion policy separately. Package update alone must never delete history.
- External webhook/raw-payload releases: deploy disabled, complete secret and
  privacy configuration, then enable one integration at a time.

## Verification checklist when adopting a future release

- package and lockfile resolve the same published version;
- generated component API matches the installed package;
- Convex schema deploy completes before app code calls new functions;
- existing Garmin OAuth, webhook, reconnect, backfill, Synthetic, native SDK
  push, and canonical summary tests remain green;
- any optional migration exposes progress and completes idempotently;
- rollback safety is evaluated against writes made by the new version; and
- production enablement is separate from package deployment.
