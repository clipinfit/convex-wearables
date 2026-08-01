---
date: 2026-08-01
status: ACTIVE_ROADMAP
owner_repo: convex-wearables
reference_repo: ../open-wearables
reference_revision: 87f589316f269662450d1d83f5b5c640fc1531e6
---

# Open Wearables Alignment Roadmap

## Purpose

This roadmap converts the July/August 2026 comparison with Open Wearables into an
ordered local delivery plan. Open Wearables is a behavioral and architectural
reference, not a source tree to copy wholesale. Convex-native workflows,
component isolation, provider-aware summaries, synthetic data, and tiered
time-series retention remain the local architecture.

No item in this roadmap authorizes publishing a package, changing a host app's
dependency, or enabling a destructive policy. Those are separate operator
decisions.

## Released reliability tranche

Version `0.7.0` released the first reliability tranche:

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

## Active delivery order

| Order | Workstream | PRD | Why now |
|---|---|---|---|
| Released (`0.8.0`) | Provider lifecycle and durable deletion | [provider-lifecycle-deletion-prd.md](./provider-lifecycle-deletion-prd.md) | Released with bounded Workflow deletion, ingestion fencing, explicit provider deregistration, tests, and public MDX documentation. |
| 2 | SDK ingestion resilience | [sdk-ingestion-resilience-prd.md](./sdk-ingestion-resilience-prd.md) | Prevents one malformed SDK row from discarding an otherwise useful batch; directly supported by recent upstream hardening. |
| 3 | Provider-neutral workout enrichment | [workout-enrichment-prd.md](./workout-enrichment-prd.md) | Largest remaining provider-neutral data capability; builds on the existing retention system. |
| 4 | Generic outgoing event delivery, phase 1 | [outgoing-webhooks-prd.md](./outgoing-webhooks-prd.md) | Gives hosts an optional internal event boundary without committing to external webhook infrastructure. |
| 5 | Live provider webhooks | [polar-suunto-webhooks-prd.md](./polar-suunto-webhooks-prd.md) | Improves freshness for enabled providers after the internal event contract is stable. |
| 6 | Event retention | [event-retention-policy-prd.md](./event-retention-policy-prd.md) | Extends the existing time-series policy to semantic events, with destructive behavior explicitly gated. |

## Deferred or demand-driven work

| Workstream | PRD | Decision |
|---|---|---|
| First-class health scores | [health-scores-prd.md](./health-scores-prd.md) | Deferred. Open Wearables supports score models, but score meaning, canonicalization, and AI eligibility currently belong more naturally to the consuming application. Revisit only with a provider-fidelity or multi-app portability requirement. |
| Unified sync observability | [sync-status-observability-prd.md](./sync-status-observability-prd.md) | Deferred for low incremental value. Workflow plus existing sync/backfill records already support CLIPIN's current UI and operational needs. |
| Ultrahuman | [ultrahuman-provider-prd.md](./ultrahuman-provider-prd.md) | Demand-driven on partner access and a concrete consumer requirement. |
| Shared provider accounts | [shared-provider-accounts-prd.md](./shared-provider-accounts-prd.md) | Demand-driven on an explicit multi-profile/shared-device product model. |
| Raw provider payload capture | [raw-provider-payload-storage-prd.md](./raw-provider-payload-storage-prd.md) | Optional debugging capability with privacy and storage costs; not a default ingestion dependency. |

## Migration and upgrade matrix

| Workstream | Component schema change | Existing-row rewrite | Consumer code/config change | Generic consumer upgrade path |
|---|---|---|---|---|
| Reliability tranche (`0.7.0`) | None | None | Optional lookback config; Strava secret only if route is mounted | Update the package; no migration command is required. |
| Provider lifecycle/deletion | Additive `dataDeletionOperations` table and indexes | None | Adopt explicit start/status APIs; optionally expose provider deregistration | Deploy schema, then replace direct whole-user deletion with workflow start/status handling. Keep local disconnect semantics. |
| SDK ingestion resilience | None in phase 1 | None | Optional adoption of versioned v2 endpoint and partial-result handling | Update and deploy the package; SDK clients migrate independently when ready. |
| Workout enrichment | Additive child tables and indexes | None required; optional historical enrichment | Adopt new read APIs only when product surfaces need detail | Update the package and deploy schema before querying the new APIs. |
| Outgoing events phase 1 | None when host callback only | None | Configure optional host function | Update the package and add a host function only when consuming events. |
| Outgoing subscriptions phase 2 | Additive event/subscription tables | None | Route/secrets if external delivery enabled | Deploy schema before enabling delivery. Keep disabled by default. |
| Live provider webhooks | Optional provider settings fields | None | Mount routes and configure secrets/provider subscriptions | Roll out one enabled provider at a time. |
| Event retention | Additive policy/cursor tables | No rewrite, but enabling policy deletes expired data | Explicit policy configuration and dry run | Deploy with retain-forever default; consumers approve and preview destructive policies separately. |

Deferred work keeps its own migration analysis in its PRD but is not part of the
active release pipeline.

## Migration rules for every future PRD

Every implementation must answer these questions before code is merged:

1. Does the component schema add, widen, narrow, rename, or remove anything?
2. Can the new schema deploy against documents written by the oldest supported
   package version?
3. Is a host-run migration required, optional, or explicitly prohibited?
4. Must indexes on existing large tables be staged?
5. Can old and new host code run against the compatibility release during a
   rolling deployment?
6. What must a generic consumer update: package only, schema deploy,
   environment, wrapper functions, UI reads, or a migration invocation?
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
