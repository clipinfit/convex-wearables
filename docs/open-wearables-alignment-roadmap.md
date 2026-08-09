---
date: 2026-08-01
status: ACTIVE_ROADMAP
owner_repo: convex-wearables
reference_repo: ../open-wearables
reference_revision: 44a268be623e81995e896b05ed93a56411ddf807
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
| Released (`0.9.0`) | SDK ingestion resilience | [sdk-ingestion-resilience-prd.md](./sdk-ingestion-resilience-prd.md) | Released with versioned partial-safe SDK ingestion, bounded rejection reports, tests, and public documentation. |
| Released (`0.10.0`) | Provider-neutral workout enrichment | [workout-enrichment-prd.md](./workout-enrichment-prd.md) | Released with provider-neutral segments/zones and opt-in Garmin FIT enrichment. |
| Released (`0.11.0`) | Live provider webhooks | [polar-suunto-webhooks-prd.md](./polar-suunto-webhooks-prd.md) | Released with secure receipt-first Polar, WHOOP v2, and Suunto inbound notifications, isolated durable processing, cleanup, deletion integration, tests, and docs. |
| Released (`0.12.0`) | Durable outgoing events and self-service webhooks | [outgoing-webhooks-prd.md](./outgoing-webhooks-prd.md) | Released with a transactional event contract, internal callbacks, encrypted self-service endpoints, DNS-pinned delivery, durable retries/recovery, lifecycle cleanup, tests, and docs. |
| Released (`0.13.0`) | Source-aware reads | [source-aware-reads-prd.md](./source-aware-reads-prd.md) | Released with additive data-source listing and provenance-rich event/time-series reads that preserve independent streams for consumer-owned canonicalization. |

## Deferred or demand-driven work

| Workstream | PRD | Decision |
|---|---|---|
| First-class health scores | [health-scores-prd.md](./health-scores-prd.md) | Deferred. Open Wearables supports score models, but score meaning, canonicalization, and AI eligibility currently belong more naturally to the consuming application. Revisit only with a provider-fidelity or multi-app portability requirement. |
| Unified sync observability | [sync-status-observability-prd.md](./sync-status-observability-prd.md) | Deferred for low incremental value. Workflow plus existing sync/backfill records already support CLIPIN's current UI and operational needs. |
| Ultrahuman | [ultrahuman-provider-prd.md](./ultrahuman-provider-prd.md) | Demand-driven on partner access and a concrete consumer requirement. |
| Shared provider accounts | [shared-provider-accounts-prd.md](./shared-provider-accounts-prd.md) | Demand-driven on an explicit multi-profile/shared-device product model. |
| Raw provider payload capture | [raw-provider-payload-storage-prd.md](./raw-provider-payload-storage-prd.md) | Optional debugging capability with privacy and storage costs; not a default ingestion dependency. |
| Semantic event retention | [event-retention-policy-prd.md](./event-retention-policy-prd.md) | Deferred and low priority. This is a Convex Wearables-only convenience API, not an upstream feature; consumers can implement bounded periodic event cleanup themselves. |

## Migration and upgrade matrix

| Workstream | Component schema change | Existing-row rewrite | Consumer code/config change | Generic consumer upgrade path |
|---|---|---|---|---|
| Reliability tranche (`0.7.0`) | None | None | Optional lookback config; Strava secret only if route is mounted | Update the package; no migration command is required. |
| Provider lifecycle/deletion | Additive `dataDeletionOperations` table and indexes | None | Adopt explicit start/status APIs; optionally expose provider deregistration | Deploy schema, then replace direct whole-user deletion with workflow start/status handling. Keep local disconnect semantics. |
| SDK ingestion resilience | None in phase 1 | None | Optional adoption of versioned v2 endpoint and partial-result handling | Update and deploy the package; SDK clients migrate independently when ready. |
| Workout enrichment | Additive child tables and indexes | None required; optional historical enrichment | Adopt new read APIs only when product surfaces need detail | Update the package and deploy schema before querying the new APIs. |
| Durable outgoing events and self-service webhooks | Additive endpoint, outbox-event, delivery, and attempt tables | None | Optional host callback; external delivery additionally requires host authorization wrappers, encryption configuration, and endpoint-management surfaces | Update the package and deploy the additive schema. Existing behavior is unchanged while delivery is disabled; enable callbacks or external subscriptions independently. |
| Live provider webhooks | Additive receipt/registration tables and Suunto connection-lookup index | None | Mount only selected routes; configure provider secrets/dashboard or Polar registration | Deploy schema, enable one provider at a time, and keep pull reconciliation active. |
| Source-aware reads | None | None | Optional adoption of new listing and source-aware read methods | Update and deploy the package, then adopt source-aware methods only where attribution or canonicalization is needed. |

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
