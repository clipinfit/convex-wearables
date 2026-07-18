---
date: 2026-07-18
status: ACTIVE_ROADMAP
owner_repo: convex-wearables
reference_repo: ../open-wearables
reference_revision: a33cc5c0e4c3126c743a501bfeeea31880222ddc
---

# Open Wearables Alignment Roadmap

## Purpose

This roadmap converts the July 2026 comparison with Open Wearables into an
ordered local delivery plan. Open Wearables is a behavioral and architectural
reference, not a source tree to copy wholesale. Convex-native workflows,
component isolation, provider-aware summaries, synthetic data, and tiered
time-series retention remain the local architecture.

No item in this roadmap authorizes publishing a package, changing a host app's
dependency, or enabling a destructive policy. Those are separate operator
decisions.

## Current implementation tranche

The local worktree implements the first reliability tranche:

- accept Garmin blood-pressure `measurementTimeInSeconds`;
- accept Garmin respiration `timeOffsetEpochToBreaths` with legacy fallbacks;
- fail Strava webhook verification closed against
  `STRAVA_WEBHOOK_VERIFY_TOKEN`;
- classify provider API failures structurally;
- revoke connections only for definitive 400/401 refresh-token rejection;
- preserve active connections after transient refresh failure;
- mark expired tokens without a refresh token as `expired`; and
- support optional global, provider-specific, or per-call trailing pull
  lookback, capped by the configured sync window.

These changes add no table, field, index, or validator-union member. Existing
component data needs no migration.

## Delivery order

| Order | Workstream | PRD | Why now |
|---|---|---|---|
| 1 | Provider-neutral workout enrichment | [workout-enrichment-prd.md](./workout-enrichment-prd.md) | Largest new product/data capability; makes the existing retention system more valuable. |
| 2 | First-class health scores | [health-scores-prd.md](./health-scores-prd.md) | Preserves score provenance and enables provider/internal score parity. |
| 3 | Generic outgoing event delivery | [outgoing-webhooks-prd.md](./outgoing-webhooks-prd.md) | Gives host apps a stable downstream integration boundary. |
| 4 | Live provider webhooks | [polar-suunto-webhooks-prd.md](./polar-suunto-webhooks-prd.md) | Improves freshness after the event boundary is defined. |
| 5 | Unified sync observability | [sync-status-observability-prd.md](./sync-status-observability-prd.md) | Makes richer background behavior supportable without copying SSE. |
| 6 | Ultrahuman | [ultrahuman-provider-prd.md](./ultrahuman-provider-prd.md) | Adds ring/recovery coverage when partner access and product demand exist. |
| 7 | Event retention | [event-retention-policy-prd.md](./event-retention-policy-prd.md) | Extends current time-series policy to semantic events, with destructive behavior gated. |
| 8 | Shared provider accounts | [shared-provider-accounts-prd.md](./shared-provider-accounts-prd.md) | Useful only for an explicit multi-profile/shared-device requirement. |
| Optional | Raw provider payload capture | [raw-provider-payload-storage-prd.md](./raw-provider-payload-storage-prd.md) | Debugging aid with privacy and storage costs; not a default ingestion dependency. |

## Migration and upgrade matrix

| Workstream | Component schema change | Existing-row rewrite | Host code/config change | `../clipin-app` path |
|---|---|---|---|---|
| Reliability tranche | None | None | Optional lookback config; Strava secret only if route is mounted | Update package and deploy when released; no migration command. Current Garmin-only route config needs no change. |
| Workout enrichment | Additive child tables and indexes | None required; optional historical enrichment | Adopt new read APIs only when UI needs detail | Update package, deploy schema, then add CLIPIN wrappers/UI. Do not query new APIs before deploy. |
| Health scores | Additive `healthScores` table | Optional idempotent backfill for historical scores | New read APIs; old summary reads remain | Deploy compatibility release first; optionally run component backfill; migrate UI later. |
| Outgoing events phase 1 | None when host callback only | None | Configure optional host function | Update package; add CLIPIN internal function only when consuming events. |
| Outgoing subscriptions phase 2 | Additive event/subscription tables | None | Route/secrets if external delivery enabled | Deploy schema before enabling delivery. Keep disabled by default. |
| Live provider webhooks | Optional provider settings fields | None | Mount routes and configure secrets/provider subscriptions | No CLIPIN action until those providers are enabled. Roll out one provider at a time. |
| Sync observability | Additive bounded `syncEvents` table or optional job fields | None; historical synthesis optional | New reactive queries | Deploy schema, keep existing status UI, then switch reads after coverage verification. |
| Ultrahuman | Widen provider validator union; adapter code | None | Credentials, UI, exhaustive TypeScript switches | Update/deploy component before adding provider config or UI. |
| Event retention | Additive policy/cursor tables | No rewrite, but enabling policy deletes expired data | Explicit policy configuration and dry run | Deploy with retain-forever default; approve and preview CLIPIN policy separately. |
| Shared accounts | Prefer additive lease/coordination table | None | Product identity and deletion semantics | Do not enable until CLIPIN decides whether sharing is allowed and how consent works. |
| Raw payload capture | None for host sink; optional metadata table | No historical backfill | Configure encrypted blob sink and retention | Separate privacy/security approval; never enable silently. |

## Migration rules for every future PRD

Every implementation must answer these questions before code is merged:

1. Does the component schema add, widen, narrow, rename, or remove anything?
2. Can the new schema deploy against documents written by the oldest supported
   package version?
3. Is a host-run migration required, optional, or explicitly prohibited?
4. Must indexes on existing large tables be staged?
5. Can old and new host code run against the compatibility release during a
   rolling deployment?
6. What must `../clipin-app` update: package only, schema deploy, environment,
   wrapper functions, UI reads, or a migration invocation?
7. Is rollback code-only, or would new writes make rollback unsafe?

Additive tables should avoid indexes on existing tables when a child-table
model provides the same query path. Any required existing-table index must be
staged first and queried only after a later deploy makes it non-staged.

## Release gates

Before any future package is published by an operator:

- full tests, typecheck, lint, and build pass;
- generated component API is reviewed for accidental breaking changes;
- the PRD migration section matches the final schema diff;
- a clean install is tested in a disposable host app;
- `../clipin-app` compatibility is checked against its pinned package usage;
- upgrade steps are added to `UPGRADING.md`; and
- publishing remains a deliberate separate action.
