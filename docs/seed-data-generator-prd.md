# Seed Data Generator PRD

## Status

Draft.

## Source Signal

A reference implementation added a seed data generator and later added Oura as a seed provider.

## Problem

Developing and testing wearable UX requires realistic multi-day data. `convex-wearables` users currently need to connect real providers or hand-write SDK payloads.

## Goals

- Provide a developer-only seed generator for workouts, sleep, time-series, daily summaries, and future health scores.
- Make demo and QA setup repeatable.
- Keep production deployments safe by requiring explicit calls and optional guardrails.

## Non-Goals

- Do not generate clinically meaningful synthetic data.
- Do not run automatically in production.
- Do not include raw provider payloads.

## Requirements

- Add an action:

```ts
seedWearablesData({
  userId: string;
  provider?: ProviderName;
  days: number;
  profile?: "active" | "sedentary" | "recovery" | "mixed";
  clearExisting?: boolean;
})
```

- Generate internally normalized data through existing component mutations.
- Use deterministic seeds when requested.
- Tag generated source metadata with `source: "seed"` and `originalSourceName: "convex-wearables-seed"`.
- Document production safety.

## Existing User Impact

No schema migration is required if generated rows use existing tables.

Recommended npm versioning:

- Minor version if additive.

`../clipin-app` impact:

- No required app changes.
- Useful for local and staging demo accounts.
- Should be hidden behind a development or admin-only control.

Breaking risk:

- If `clearExisting` is misused, user data could be deleted. Default it to `false` and require explicit provider/user scoping.

## Versioning Guidance

Expected bump: minor (`0.3.0` or later pre-1.0 minor) because this is a new developer-facing feature.

Use a patch only if adding small test-only fixtures that are not exported as public APIs.

Use a major release, or the next pre-1.0 minor with explicit breaking notes, if implementation:

- changes existing ingestion APIs to support seed data;
- adds required schema fields to existing tables;
- introduces automatic seed behavior.

Implementation considerations:

- Do not run automatically in production.
- Require explicit `userId`, provider scope, and `clearExisting: true` for destructive cleanup.
- Mark generated rows through existing source metadata or a dedicated optional marker before adding cleanup APIs.
- `../clipin-app` should expose this only in local/staging/admin contexts.

## Rollout

1. Add generator helpers and tests.
2. Add action behind explicit call only.
3. Document local/staging usage.
4. Optionally add host app UI in `clipin-app`.

## Open Questions

- Should seeded rows have a dedicated boolean marker for cleanup, or is source metadata enough?
- Should generated data include edge cases such as naps, partial days, and missing sources?
