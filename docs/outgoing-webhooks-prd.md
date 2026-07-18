---
date: 2026-07-18
status: PLANNED
priority: P1
semver: minor
owner_repo: convex-wearables
---

# Outgoing Webhooks PRD

## Status

Planned after first-class health-score storage.

## Source Signal

A reference implementation added outgoing webhooks in April 2026 and later fixed full time-series sample payloads, disabled dispatch when Svix is not configured, and emitted Suunto live workout events.

## Problem

`convex-wearables` currently has `onDataSynced`, but it is a single host callback. It does not give consumers a standard event subscription model for workouts, sleep, data points, summaries, or sync lifecycle changes.

Apps that want downstream processing must build custom callback plumbing and cannot subscribe narrowly to events such as `workout.created` or `series.heart_rate.created`.

## Goals

- Add a generic outgoing event model that can drive host callbacks or external webhook delivery.
- Support event types for workouts, sleep, time-series batches, daily summaries, and sync lifecycle events.
- Make delivery optional and non-blocking.
- Preserve Convex function reliability when downstream delivery fails.

## Non-Goals

- Do not require Svix. The component should support a host-provided delivery function first.
- Do not store raw health payloads in outgoing events by default.
- Do not expose secrets or provider tokens in event payloads.

## Requirements

- Add event type constants, for example:
  - `workout.created`
  - `sleep.created`
  - `summary.activity.updated`
  - `sync.started`
  - `sync.completed`
  - `sync.failed`
  - `series.heart_rate.created`
  - `series.<seriesType>.created`
- Add a host config hook:

```ts
onWearablesEvent?: FunctionReference<"mutation" | "action", "internal", WearablesEventArgs>;
```

- Emit events after successful data writes.
- Batch time-series event samples with a configurable max sample count.
- Include idempotency keys in emitted event args.
- Never block ingestion if event delivery fails.

## Data Model

Optional tables:

- `outgoingWebhookEvents`: delivery audit and retry state.
- `outgoingWebhookSubscriptions`: if this component owns external webhook endpoints.

Initial implementation can avoid new tables by calling a host function and relying on host persistence. That path has no migration.

## Existing User Impact

Minor npm update if additive.

`../clipin-app` impact:

- No required migration if `onWearablesEvent` is optional.
- The app can opt in to event processing gradually.
- If event audit tables are added, `clipin-app` must deploy the new component schema before enabling delivery.

Breaking risk:

- Replacing `onDataSynced` with the new event system would be breaking. Keep `onDataSynced` and emit both for at least one major version.
- Large event payloads can increase function and bandwidth costs. Default to summary payloads plus bounded time-series samples.

## Versioning Guidance

Expected bump: minor (`0.3.0` or later pre-1.0 minor) if outgoing events are opt-in and `onDataSynced` remains supported.

Use a major release, or the next pre-1.0 minor with explicit breaking notes, if implementation:

- removes or changes `onDataSynced`;
- requires host apps to provide a webhook delivery function;
- adds mandatory secrets or environment variables;
- changes ingestion timing or makes webhook delivery part of the write transaction.

Implementation considerations:

- Delivery must be best-effort and isolated from ingestion failures.
- Start with host-provided callback delivery before adding any Svix-like external delivery.
- Bound time-series sample payloads and document cost implications.
- `../clipin-app` should opt in behind a feature flag and keep existing downstream processing until event parity is verified.

## Rollout

1. Define event type constants and payload shapes.
2. Implement host callback dispatch with try/catch isolation.
3. Emit events from SDK push, Garmin webhooks, and sync workflow.
4. Add docs with payload examples and idempotency semantics.
5. Add optional external webhook delivery as a separate phase.

## Migration and Existing Consumer Upgrade Path

Phase 1 must be schema-free: add an optional host-provided
`onWearablesEvent` function and keep `onDataSynced`. Existing hosts require no
configuration and existing documents require no migration.

Phase 2 may add `outgoingWebhookSubscriptions` and
`outgoingWebhookDeliveries`. Those are additive tables with no historical
rewrite. A host must deploy that schema before enabling external subscriptions.

For `../clipin-app`:

- package-only update is safe while both callbacks are optional;
- CLIPIN should add an authenticated internal event handler only when it has a
  concrete consumer;
- external delivery must stay disabled until secrets, retries, retention, and
  support ownership are configured; and
- existing downstream work must remain active until event parity is measured.

Rollback from phase 1 is code-only. Rollback from phase 2 must leave additive
tables in schema until stored delivery records are intentionally disposed.

## Acceptance Criteria

- Ingestion success never depends on downstream delivery success.
- Every emitted event has a stable type, version, timestamp, and idempotency key.
- Time-series payloads are bounded by count and encoded size.
- Secrets and provider tokens never appear in event payloads or logs.
- `onDataSynced` remains compatible for at least one deprecation cycle.
- Delivery retries distinguish retryable failures from permanent 4xx responses.

## Open Questions

- Should delivery happen from mutations, or should events be queued and delivered from actions?
- Should consumers receive rollup samples, raw samples, or both?
