---
date: 2026-07-18
status: DEFERRED_LOW_VALUE
priority: DEFERRED
semver: minor
owner_repo: convex-wearables
---

# Sync Status Observability PRD

## Status

Deferred for low incremental value. Convex Workflow plus the existing
`syncJobs` and `backfillJobs` records already provide durable execution and the
status needed by the current CLIPIN experience. A unified event stream should
be reconsidered only when a concrete multi-source operational or user-facing
query cannot be served cleanly from those records.

## Source Signal

A reference implementation added a sync status stream in May 2026 with recent events, run summaries, progress, and terminal states.

## Problem

`convex-wearables` has `syncJobs` and `backfillJobs`, but host apps still need to infer status from job rows. There is no unified event history for:

- manual sync;
- cron sync;
- SDK push;
- Garmin webhook;
- Garmin backfill;
- provider-specific partial failures.

## Goals

- Provide a user-facing sync status API built on existing Convex tables.
- Track recent sync runs and lifecycle transitions.
- Support progress metadata for long workflows.
- Make the model useful without SSE because Convex queries are already reactive.

## Non-Goals

- Do not introduce Redis or SSE.
- Do not require all providers to emit fine-grained progress.
- Do not replace `syncJobs` in the first phase.

## Requirements

- Add `syncEvents` table:

```ts
syncEvents: {
  runId: string;
  userId: string;
  provider: ProviderName;
  source: "manual" | "cron" | "webhook" | "sdk" | "backfill";
  stage: "started" | "progress" | "completed" | "failed" | "canceled";
  status: "running" | "completed" | "failed" | "canceled";
  message?: string;
  progress?: number;
  itemsProcessed?: number;
  itemsTotal?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
  endedAt?: number;
  createdAt: number;
}
```

- Add queries:
  - `getRecentSyncEvents({ userId, limit })`
  - `getSyncRuns({ userId, limit })`
  - `getSyncRun({ runId })`
- Emit events from sync workflow, SDK push, Garmin webhooks, and backfill workflow.
- Cap recent reads by index and limit.

## Existing User Impact

This requires a component schema migration because it adds a table.

Recommended npm versioning:

- Minor version if existing `getSyncStatus` remains stable.
- Major version only if `syncJobs` fields or status enum values change.

`../clipin-app` impact:

- Must deploy schema before using `syncEvents` APIs.
- Existing UI using current sync status helpers should keep working.
- The app can adopt richer status cards without changing mobile payloads.

## Versioning Guidance

Expected bump: minor (`0.3.0` or later pre-1.0 minor) for additive `syncEvents` storage and queries.

Use a major release, or the next pre-1.0 minor with explicit breaking notes, if implementation:

- changes `syncJobs` status values;
- removes existing sync status APIs;
- changes backfill job semantics;
- requires existing SDK/mobile payloads to include run identifiers.

Implementation considerations:

- This requires a Convex schema deploy before new queries are used.
- Do not migrate historical jobs by default.
- Add retention or pagination from the beginning to avoid unbounded reactive reads.
- `../clipin-app` should keep current sync UI until new event coverage exists for SDK push, Garmin webhook, manual sync, and backfill.

## Migration Plan

No historical migration required. New sync events start after deployment.

Optional backfill from existing `syncJobs` can create one synthetic terminal event per recent job, but it is not required and may not be worth the complexity.

## Existing Consumer Upgrade Path

Expected schema impact is an additive, bounded `syncEvents` table and possibly
optional metadata on new `syncJobs`. Existing jobs remain readable and require
no rewrite. New-table indexes do not backfill an existing large table.

For `../clipin-app`, deploy the component before adding wrapper queries. Keep
the current status UI until manual, cron, SDK, Garmin webhook, and backfill paths
all emit equivalent terminal events. Historical synthesis should remain off by
default; if added, it is an optional idempotent data migration.

## Acceptance Criteria

- Every sync source emits a terminal state or an observable stale state.
- Reads are indexed, paginated/bounded, and safe for reactive clients.
- Progress writes do not create unbounded high-churn updates on stable records.
- Retention is configured from the first release.
- Existing sync-status APIs remain compatible during adoption.

## Open Questions

- Should sync events be retained forever, TTL-like via maintenance, or host-configurable?
- Should outgoing webhook events reuse this table or remain separate?
