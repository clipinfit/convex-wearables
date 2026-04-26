---
date: 2026-03-23
status: IMPLEMENTED
semver: minor
---

# Time-Series Storage Policy Plan for `convex-wearables`

## Summary
- Replace the first storage-policy design based on coarse `mode` values with a more explicit tiered retention model.
- Let consumers describe storage policy in human terms:
  - keep raw for `24h`
  - then keep `30m` rollups until `7d`
  - then either delete, or keep coarser rollups forever
- Keep full-fidelity provider sync behavior unchanged. This is a storage and query policy only.
- Design the policy surface so it can support:
  - deployment-wide defaults
  - per-user overrides or preset assignment
  - future plan-based retention tiers in host apps

## Why The Previous `mode` Model Is Not Enough
- The initial `full` / `retained_rollup` / `summary_only` model is workable for a narrow first pass, but it hides the real storage policy behind a few implicit shapes.
- Consumers think in terms of retention windows and resolutions, not in terms of abstract modes.
- Real product requirements quickly become more expressive than a single mode:
  - raw for `24h`
  - `30m` rollups for `7d`
  - then `1h` rollups forever
  - or delete everything older than `7d`
- That means the durable concept should be storage tiers by age, not a single mode plus one or two parameters.

## Goals
- Preserve current behavior by default for backward compatibility.
- Make storage policy explicit enough that consumers can understand it at a glance.
- Support dense streams like Garmin heart rate without forcing infinite raw retention.
- Keep the policy generic so it also works for Suunto and SDK push sources.
- Allow future support for app-wide defaults plus user-specific plan overrides.
- Minimize operational strain on host deployments by making background maintenance deliberate and bounded.

## Non-Goals
- Do not reduce provider sync coverage or refuse supported data types.
- Do not make query-time aggregation the main answer to row explosion. If the goal is fewer rows, storage must actually be compacted or deleted.
- Do not force scheduled maintenance for every deployment in the first shipping phase.
- Do not overfit to Garmin only.

## Product Direction

### 1. Replace `mode`-first configuration with tiered storage windows
- Define policy as ordered tiers by data age.
- Each tier answers:
  - what representation is stored in this age window
  - for how long that representation is retained
- The two main representations are:
  - raw
  - rollup with a bucket size

### 2. Use human-friendly durations in the public API
- The configuration should accept user-friendly durations such as:
  - `15m`
  - `24h`
  - `7d`
  - `30d`
- Use an `ms`-style parser at the API boundary for ergonomics.
- Normalize durations into numeric milliseconds or minutes before persisting.
- Persist normalized values, not the original strings, so reads and internal jobs stay simple.

### 3. Model total retention explicitly
- If no tier covers data older than a given age, that data is deleted.
- This is clearer than having a hidden assumption that rollups always live forever.
- Consumers should be able to express all of these:
  - raw `24h`, rollup `30m` forever
  - raw `24h`, rollup `30m` until `7d`, then delete
  - raw `24h`, rollup `30m` until `7d`, then rollup `1h` forever

### 4. Treat global and per-user policy as separate layers
- There are two real use cases:
  - one policy for the whole deployment
  - default policy plus user-specific overrides for subscription tiers or special cases
- The design should support both, even if implementation ships in phases.

## Proposed Policy Shape

### Core tier model

```ts
type TimeSeriesTier =
  | {
      kind: "raw";
      fromAge: string; // e.g. "0m"
      toAge: string | null; // e.g. "24h", null = forever
    }
  | {
      kind: "rollup";
      fromAge: string;
      toAge: string | null;
      bucket: string; // e.g. "30m", "1h", "24h"
      aggregations?: Array<"avg" | "min" | "max" | "last" | "count">;
    };

type TimeSeriesPolicyRule = {
  provider?: ProviderName;
  seriesType?: string;
  tiers: TimeSeriesTier[];
};
```

### Normalized persisted shape
- Do not persist string durations directly.
- Convert at write time to numeric fields like:
  - `fromAgeMs`
  - `toAgeMs`
  - `bucketMs`

### Interpretation rules
- `fromAge` means the youngest age included in the tier.
- `toAge` means the oldest age included in the tier.
- `0m` means newest data.
- `null` means forever.
- Data older than the last matching tier is deleted.
- Tiers must not overlap for the same rule.
- Tiers should be ordered by age from newest to oldest.

## Example Policies

### Case 1
- Raw `24h`
- `30m` rollups for all older history forever

```ts
{
  provider: "garmin",
  seriesType: "heart_rate",
  tiers: [
    { kind: "raw", fromAge: "0m", toAge: "24h" },
    { kind: "rollup", fromAge: "24h", toAge: null, bucket: "30m" },
  ],
}
```

### Case 2
- Raw `24h`
- `30m` rollups until `7d`
- delete anything older than `7d`

```ts
{
  provider: "garmin",
  seriesType: "heart_rate",
  tiers: [
    { kind: "raw", fromAge: "0m", toAge: "24h" },
    { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
  ],
}
```

### Case 3
- Raw `24h`
- `30m` rollups until `7d`
- `1h` rollups for older history forever

```ts
{
  provider: "garmin",
  seriesType: "heart_rate",
  tiers: [
    { kind: "raw", fromAge: "0m", toAge: "24h" },
    { kind: "rollup", fromAge: "24h", toAge: "7d", bucket: "30m" },
    { kind: "rollup", fromAge: "7d", toAge: null, bucket: "1h" },
  ],
}
```

## Row Math for Garmin Heart Rate
- If Garmin emits one heart-rate point every `15s`, that is:
  - `4` rows per minute
  - `240` rows per hour
  - `5760` rows per day
- For raw `24h` plus `30m` rollups through day `7`:
  - raw: `5760` rows
  - older `6` days in `30m` buckets: `6 * 48 = 288` rows
  - total: `6048` rows for a rolling `7d` window
- By comparison:
  - full raw `7d`: `40320` rows
  - full `30m` rollups `7d`: `336` rows

## Architecture Plan

### Policy storage
- Add a dedicated policy table rather than overloading `providerSettings`.
- Policy resolution precedence should eventually be:
  1. user-specific override
  2. user-assigned preset
  3. deployment default policy
  4. built-in fallback: full raw retention

### Presets vs direct user policy
- Do not start with arbitrary per-user custom blobs unless necessary.
- Prefer this progression:
  1. deployment-wide policy only
  2. policy presets plus `userId -> presetId` assignment
  3. direct user override only if needed later
- This matches typical subscription plans better than copying policy rows per user.

### Disconnect semantics
- Disconnecting a provider should not implicitly mean immediate historical data deletion.
- Disconnect should mean:
  - stop future ingestion
  - keep existing stored data under the same retention policy unless the host app explicitly purges it
- If the effective policy has a finite oldest tier, disconnected data should continue aging out naturally until it reaches zero.
- This gives the host app two clear choices:
  - let data expire naturally under retention
  - call an explicit purge/delete API if immediate removal is desired
- Do not make “freeze historical data forever after disconnect” the default behavior, because that makes retention state depend on connection lifecycle in a way that is hard to reason about.

### Query behavior
- Queries should read from the narrowest stored resolution available for the requested age range.
- Recent windows should use raw when raw exists.
- Older windows should use the appropriate rollup tier.
- Query behavior should not need to compute expensive ad hoc aggregation over historical raw rows.

## Compaction And Retention Lifecycle

### Important distinction
- If the goal is fewer Convex rows, compaction must be a real storage rewrite.
- Query-time aggregation alone does not reduce stored row count.

### What compaction means
- Example:
  - 120 raw heart-rate points at `15s` cadence over `30m`
  - compact into 1 rollup row containing `avg`, `min`, `max`, `last`, `count`
  - delete the 120 raw rows once rollup is durable

### What can be done without cron
- Incoming historical points can be written directly to the correct tier.
- Raw-to-first-rollup compaction can be performed opportunistically during writes for the same source and series.
- This is enough for a basic first phase if policy only supports:
  - current full retention
  - one raw tier
  - one older rollup tier

### What requires scheduled maintenance
- Hard total retention deletion
- Multi-tier rollup transitions such as:
  - `30m` rollups until `7d`
  - then `1h` rollups forever
- Guaranteed cleanup when a user stops syncing new data
- Those cases require a background maintenance path because old data must still age out or move tiers even when no new writes arrive

## Cron / Background Job Tradeoffs

### Does scheduled maintenance create strain?
- Yes, it creates real read/write/delete activity on the host deployment.
- But it can be kept bounded if designed correctly.
- The wrong design is:
  - one cron per user
  - full-table scans
  - unbounded deletes in one mutation
- The right design is:
  - one component-level cron
  - queue only sources with eligible work
  - bounded batch sizes
  - resumable cursors or watermarks
  - staggered processing across runs

### Rough daily volume example
- Assume `50` users with Garmin heart rate at `15s` cadence.
- Each user produces about `5760` heart-rate rows per day.
- If policy is:
  - raw `24h`
  - `30m` rollup through `7d`
  - delete older than `7d`
- Then after warmup, each day the maintenance path roughly does:
  - per user:
    - compact `5760` raw rows into `48` rollup buckets
    - delete `48` expired rollup rows at the `7d` edge
  - across `50` users:
    - `288000` raw-row deletions per day
    - `2400` rollup upserts per day
    - `2400` rollup deletions per day
- That is meaningful background work. It is not absurdly high, but it is not free either.

### Cost guidance
- Reads, writes, deletes, and function execution all contribute to operational cost.
- Hard retention deletion and multi-tier migration should therefore be treated as an explicit feature, not invisible background behavior forced on every host app.

### Recommendation for scheduling
- Make scheduled maintenance opt-in for the first release that includes total retention deletion or older-tier migration.
- Keep deployment-wide defaults simple.
- Only enable background maintenance when the configured policies actually require it.

## Rollout Strategy

### Phase 1
- Replace the public config with tier-based policy definitions.
- Accept human-friendly durations and normalize internally.
- Support deployment-wide policy only.
- Support one raw tier plus one rollup tier.
- Keep compaction opportunistic on writes.
- Preserve default fallback behavior as full raw storage.

### Phase 2
- Add optional scheduled maintenance for:
  - total retention deletion
  - guaranteed cleanup when no new writes arrive
- Keep this feature opt-in.

### Phase 3
- Add multi-rollup-tier support.
- Example:
  - raw `24h`
  - `30m` rollups until `7d`
  - `1h` rollups forever
- This phase almost certainly depends on scheduled maintenance.

### Phase 4
- Add policy presets and user assignment.
- Support:
  - deployment default preset
  - per-user preset override
- Consider direct user custom policy only if preset assignment is not sufficient.

## Open Design Questions
- Whether to adopt the `ms` package directly or a small equivalent parser to reduce dependency surface.
- Whether scheduled maintenance should be disabled by default unless a policy requires:
  - deletion after retention
  - deeper rollup-tier migration
- Whether phase 1 should deliberately reject multi-tier definitions until phase 3 lands.
- Whether per-user policy should be limited to preset assignment for the first version that supports user-level variation.
- Whether host apps should also get an explicit `purgeOnDisconnect` option or API helper, separate from normal retention.

## Recommendation
- Move the policy model from implicit `mode` values to explicit storage tiers by age.
- Ship the first rewrite with:
  - human-friendly duration input
  - deployment-wide policy
  - one raw tier and one rollup tier
  - opportunistic write-time compaction
- Delay total retention deletion and second older rollup tiers until scheduled maintenance is added as an explicit, opt-in capability.
- When user-level policy arrives, prefer presets plus assignment over arbitrary per-user policy blobs.
