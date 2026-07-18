# Synthetic provider

## Status

Implemented for the next release after `0.4.0`.

## Architecture

Synthetic wearable data is represented as a first-class provider rather than as
a marker attached to Garmin or another real integration:

- canonical provider: `synthetic`;
- one normal connection per user;
- one `SynthDevice` data source beneath that connection; and
- normalized events, time-series points, daily summaries, and sync history.

The normalized read APIs do not special-case generated data. Provider-aware
queries can select `synthetic` exactly as they select Garmin, Whoop, or Apple.
Real provider connections coexist with it and never require takeover logic.

## Public API

The component exposes:

- `components.wearables.synthetic.seed`;
- `components.wearables.synthetic.status`; and
- `components.wearables.synthetic.clear`.

`WearablesClient` provides matching helpers:

- `isSyntheticProviderEnabled`;
- `seedSyntheticData`;
- `getSyntheticDataStatus`; and
- `clearSyntheticData`.

## Userland enablement

The host opts in when constructing the client:

```ts
const wearables = new WearablesClient(components.wearables, {
  providers: {
    synthetic: { enabled: process.env.ENABLE_SYNTHETIC_WEARABLES === "true" },
  },
});
```

The client rejects generation, status, and clear calls while the provider is
disabled. Component functions remain directly callable by host functions, so
the host must expose them only through its authenticated development/admin
policy. There is no HTTP route and generation never runs automatically.

## Generation

`seed` accepts a user ID, explicit ISO date range, IANA timezone, optional
profile, optional deterministic random seed, and optional `asOf` timestamp. A
range is limited to 31 days and cannot end after the `asOf` day. Events and
time-series points never extend beyond `asOf`, which defaults to generation
time.
The generated integration includes:

- sleep and workout events;
- heart rate, steps, recovery, HRV, and SpO2 time series;
- activity, sleep, and recovery daily summaries; and
- a completed sync job plus `lastSyncedAt` on the connection.

Identical user, date, profile, and seed inputs generate identical health values.
Extending a range does not change prior calendar days. The `sedentary` profile
keeps steps, active calories, and sleep below the default UI goals so partial
score states can be exercised. Generated values are plausible UI fixtures, not
clinically meaningful data.

## Replacement and cleanup

Seeding fails if a synthetic connection already exists unless
`replaceExisting: true` is supplied. Generation, replacement, and normalized
writes run in one mutation, so failures roll back atomically and concurrent
replacements cannot leave partial or orphaned fixtures.

`clear` traverses the synthetic connection and its data sources, deleting their
events, time-series points, rollups, series state, summaries, and sync jobs. It
is idempotent and cannot select another provider's rows.

## Provider capabilities

The provider advertises `generated: true` and no OAuth, pull, client SDK,
webhook, historical sync, or backfill capability. Generic capability routing
therefore excludes it from provider workflows without checking synthetic flags
inside OAuth, connection, data-source, summary, or backfill code.

## Versioning

Recommended future version: `0.5.0`. Adding a provider literal and public
functions is an additive pre-1.0 minor change. Existing component data remains
valid and no stored-data migration is required.
