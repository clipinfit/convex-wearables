---
date: 2026-08-09
status: RELEASED
semver: minor
released_version: 0.13.0
owner_repo: convex-wearables
reference_repo: ../open-wearables
reference_revision: 44a268be623e81995e896b05ed93a56411ddf807
---

# Source-Aware Reads PRD

## Summary

Convex Wearables stores independent provider, writer, and device streams under
`dataSources`. Source-aware reads make that provenance available through the
public `WearablesClient` without choosing a canonical source or suppressing
cross-provider duplicates.

The implementation is informed by Open Wearables' richer source metadata
responses, adapted to Convex's document model and policy-aware rollup reads.

## Problem

Before this work:

- `getTimeSeries` merged points from every source and returned no source key;
- event documents carried `dataSourceId` internally, but the public event type
  did not contractually expose it; and
- component queries could list `dataSources`, but `WearablesClient` did not
  expose those queries.

That made it unnecessarily difficult for a consumer to apply its own provider
precedence, mirrored-origin detection, attribution, or canonical view logic.

## Design principles

- Preserve provider streams; do not merge or delete legitimate source rows.
- Keep canonical selection and cross-provider deduplication in the consumer.
- Treat `provider` as the integration family and `source` /
  `originalSourceName` as writer attribution, not interchangeable identities.
- Preserve time-series storage-policy behavior, including rollup-backed reads.
- Avoid repeating the same metadata on every dense time-series point.
- Keep every existing read method and response unchanged.

## Public API

The additive client methods are:

```ts
getDataSources(ctx, { userId })
getProviderDataSources(ctx, { userId, provider })

getEventsWithSources(ctx, {
  userId,
  category,
  provider?,
  dataSourceId?,
  startDate?,
  endDate?,
  limit?,
  cursor?,
})

getTimeSeriesWithSources(ctx, {
  userId,
  seriesType,
  startDate,
  endDate,
  provider?,
  dataSourceId?,
  limit?,
  order?,
})
```

Each source-aware result uses a normalized envelope:

```ts
{
  events: Array<HealthEvent & { dataSourceId: string }>,
  // or points: Array<DataPoint & { dataSourceId: string }>
  dataSources: WearableDataSource[],
}
```

The sidecar contains each represented data source once. Consumers can create a
map keyed by `_id`, preserving response bandwidth for dense time series.

`WearableDataSource` exposes:

- provider;
- source/writer;
- original source name;
- device model and device type;
- software version;
- connection reference; and
- stable data-source ID.

It intentionally does not synthesize device marketing names. Presentation
catalogues and localized labels belong to the consumer.

## Filtering and ownership

- Omitting both optional filters returns independent streams across providers.
- `provider` limits the read to one provider family.
- `dataSourceId` limits the read to one exact writer/device stream.
- Supplying both requires the data source to match the provider.
- A data source that does not belong to `userId` produces an empty result; its
  metadata and rows are not exposed.

Event results retain cursor pagination and newest-first selection. Their opaque
cursor includes a stable event tie-breaker so events from different sources
with the same start timestamp are not skipped between pages. Time-series results
retain the existing semantics: the default selects the newest bounded set and
returns it chronologically; `order` can request explicit ascending or descending
selection.

## Performance

The event query uses the existing `by_source_category_time` index for each
eligible source, merges bounded candidates, and returns only represented source
metadata. The time-series query reuses the existing policy-aware raw/rollup
reader per source, then performs the same bounded global ordering as
`getTimeSeries`.

No table scan, new index, schema field, or denormalized metadata copy is added.
The sidecar response avoids repeating device metadata for every point.

## Compatibility and migration

This is a backwards-compatible minor feature released in `0.13.0`:

- no component schema change;
- no existing-row rewrite;
- no environment or route change;
- no host migration command; and
- no behavior change to `getEvents`, `getEvent`, or `getTimeSeries`.

Consumers opt in per read path. Rollback consists of returning to the legacy
methods; newly written data remains compatible with older package versions.

## Testing

Coverage includes:

- complete public data-source metadata;
- multi-provider event and time-series attribution;
- provider filtering;
- exact data-source filtering;
- rejection of cross-user data-source access;
- ordering and existing policy-aware read behavior; and
- `WearablesClient` forwarding for every new method.

## Documentation requirements

- README API tables and a complete source-map example;
- Fumadocs source-aware reads guide;
- Fumadocs client and data-model references;
- `UPGRADING.md` migration and rollback guidance; and
- alignment roadmap status.

## Acceptance criteria

- A consumer can identify the provider, writer, and device for every returned
  source-aware event or point.
- No read performs canonical provider selection or cross-provider deduplication.
- Existing public methods remain compatible.
- Dense reads do not repeat full metadata per point.
- No source owned by another user is returned through an exact-source filter.
- Tests, lint, typecheck, build, and package dry run pass.
