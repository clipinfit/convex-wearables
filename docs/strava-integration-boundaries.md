---
date: 2026-07-18
status: DESIGN_DECISION
owner_repo: convex-wearables
consumer_example: ../clipin-app
review_before_implementation: true
---

# Strava Integration Boundaries

## Decision

`convex-wearables` may provide provider-neutral Strava authentication,
synchronization, normalization, lifecycle handling, and same-provider
idempotency. It must preserve enough provenance for a host application to
interpret the data, but it must not choose a canonical record across providers.

Cross-provider reconciliation is a product policy. A host such as CLIPIN owns
whether a Garmin workout and a Garmin-origin workout observed through Strava
represent the same real-world event, which record to display, and whether data
from either source may participate in summaries, sharing, or AI context.

## Deduplication boundary

The component distinguishes two different problems:

1. **Same-provider replay:** the same Strava activity, Garmin activity, or
   webhook is delivered more than once. The component should upsert it using a
   stable provider identity.
2. **Cross-provider overlap:** two provider records may describe the same
   physical workout. The component stores both with provenance. It does not
   silently merge, suppress, or rank them.

Current event deduplication is intentionally limited to provider identifiers
and `dataSourceId + startDatetime + endDatetime`. Because Garmin and Strava use
different provider identifiers and data sources, a Garmin record and its
Strava representation can coexist.

Timestamp-only cross-provider matching must not be added to component writes:
distinct workouts can overlap, and provider calculations can legitimately
differ in start time, duration, distance, calories, and heart rate.

## Provenance required from Strava ingestion

Before treating the Strava integration as complete, normalized records should
preserve available origin evidence separately from the ingestion provider:

- ingestion provider (`strava`);
- Strava activity ID;
- Strava `external_id` and `upload_id`, when returned;
- `device_name` and other original-source attribution;
- normalized start/end time and workout type; and
- deletion/update identity needed to honor provider lifecycle events.

These fields are evidence, not an instruction to merge. A future host-side
reconciliation service may use a provider-origin identifier as a strong match,
or device attribution plus bounded time/duration/distance similarity as a
candidate. Weak matches should remain separate or require user confirmation.

## Host application responsibility

A consumer such as CLIPIN owns:

- canonical workout views and source priority;
- cross-provider duplicate candidates and confidence thresholds;
- whether a direct Garmin record is preferred over a Garmin-origin Strava
  record;
- user-visible attribution and links;
- derived summaries, scores, and projections;
- consent and audience rules; and
- retention or deletion rules that are stricter than the component defaults.

The component database should be treated as a normalized evidence store, not
as the product's single canonical interpretation. Optional reconciliation
helpers may eventually return candidates, but must not mutate or hide source
records without an explicit host decision.

## AI consent and derived provenance

AI eligibility is outside this component. A host may exclude `strava` from its
AI-consent allow-list, but filtering only the final source row is insufficient
if a source-neutral summary, score, embedding, or synthetic record was derived
from Strava data.

Any host that creates derived records should preserve contributing-source
provenance. Its AI-context builder must reject a derived record whenever a
contributing source is not allowed. Strava data must not enter prompts,
embeddings, model inputs, evaluation, or derived AI context unless the policy
and the user's consent both expressly allow that use.

## Strava compliance gate

As assessed on 2026-07-18, Strava's API terms impose restrictions beyond
technical deduplication, including restrictions concerning combining Strava
data with other customer data, AI/ML use, retention, deletion, and who may see
the data. See the current [Strava API Agreement](https://www.strava.com/legal/api)
and [Strava API Policy](https://www.strava.com/legal/api_policy). Strava's
[activity API reference](https://developers.strava.com/docs/reference/) also
describes origin fields and Garmin attribution.

These terms may change and this document is not legal advice. Before enabling
Strava in a host application, the operator must re-review the then-current
terms and obtain any necessary legal review or written provider approval.
Implementing an adapter does not itself authorize storage, combination,
display, analytics, or AI use.

Strava enablement should therefore remain a separate host-level feature and
compliance decision. A safe component default is capability without automatic
host activation.

## Implementation checklist

- Preserve provider and origin metadata without conflating them.
- Keep same-provider replay protection deterministic.
- Do not add cross-provider merging to ingestion mutations.
- Ensure Strava updates and deletions target only the corresponding Strava
  record.
- Document which returned fields are stored and for how long.
- Re-review API terms, retention, display, attribution, and AI restrictions.
- In each host, define canonical-view, consent, derived-provenance, and deletion
  behavior before enabling the connection.
- Test the Garmin-direct plus Garmin-through-Strava scenario explicitly.
