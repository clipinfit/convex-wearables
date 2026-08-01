---
date: 2026-08-01
status: PLANNED
priority: P1
semver: minor
owner_repo: convex-wearables
---

# SDK Ingestion Resilience PRD

## Summary

Allow a normalized SDK batch to accept valid rows when a small number of rows
are malformed, and return a structured, privacy-safe ingestion report. Keep
strict validation inside storage mutations and introduce the behavior through
a versioned ingestion boundary so existing callers retain their current
all-or-nothing contract.

## Source signal

Open Wearables added SDK validation and request logging improvements in
`2e3e6dd6`, logic to drop and log incorrect SDK rows in `3c077292`, and optional
time-range hardening in `87f58931` in July 2026. Together these changes avoid
rejecting a whole synchronization request for isolated malformed rows and make
failures easier to diagnose.

The current component validates arrays with strict Convex validators at the
public action boundary. One invalid row therefore rejects the action before the
handler can identify, skip, or report that row.

## Goals

- Persist valid rows from a partially malformed request.
- Give SDK clients deterministic accepted, rejected, and stored counts.
- Produce bounded diagnostics without logging health values or raw payloads.
- Preserve idempotent retries and existing v1 behavior.
- Keep internal storage functions strongly validated.

## Non-goals

- Do not silently coerce unknown units or ambiguous timestamps.
- Do not accept an unbounded request body.
- Do not echo rejected source rows in responses or logs.
- Do not make partial acceptance the behavior of the existing endpoint.
- Do not add an ingestion-receipt table in the first phase.

## Versioned API

Retain the current SDK push endpoint as v1. Add a v2 endpoint/action with a
permissive transport envelope and explicit parsing:

```ts
ingestNormalizedPayloadV2({
  userId,
  provider,
  requestId,
  payload,
  mode?: "partial" | "strict",
})
```

At the boundary, `payload` may use `v.any()` or arrays of `v.any()` only so the
handler can inspect invalid rows. Immediately parse it into known category
schemas. Every internal mutation continues to receive typed, validated rows.

Default v2 mode is `partial`. `strict` validates all rows and persists none if
any row is invalid, for consumers that require request-level atomicity.

The response is versioned and structured:

```ts
{
  requestId: string;
  status: "accepted" | "partially_accepted" | "rejected";
  counts: {
    received: number;
    accepted: number;
    inserted: number;
    updated: number;
    skipped: number;
    rejected: number;
  };
  categories: Record<string, CategoryCounts>;
  rejections: Array<{
    category: string;
    index: number;
    code: string;
    path?: string;
    message: string;
  }>;
  rejectionCountTruncated: number;
}
```

Cap rejection samples and sanitize messages. They may describe a field and
constraint but must not include its supplied value.

## Validation rules

- Reject an invalid top-level envelope or unknown provider as a whole request.
- Enforce request byte and row-count limits before expensive parsing.
- Validate each category row independently in partial mode.
- Reject unknown category keys unless explicitly designated metadata.
- Use exact timestamp/unit/range rules shared with internal normalized types.
- Treat cross-row invariants as category-level failures only when rows cannot
  be evaluated independently.
- Record a stable rejection code suitable for client metrics and tests.

The parser should return typed discriminated results rather than throw for
expected row errors. Unexpected parser or storage exceptions remain failures
and use the existing retry/error path.

## Writes, atomicity, and retries

Group accepted rows into bounded category batches. Each storage mutation is
atomic, but the entire request is not atomic in partial mode. The response and
documentation must say which rows were stored.

Use existing deterministic identities for data points, events, and summaries.
`requestId` deduplicates request processing where practical but must not be the
sole data identity. Retrying after an interrupted response must upsert the same
records rather than duplicate them.

If one accepted category later fails to write, return or record a retryable
request failure rather than mislabel those rows as validation rejections.
Clients can retry the request safely because writes are idempotent.

## Logging and privacy

Log only:

- request ID, provider, category, and payload byte/row counts;
- accepted/rejected aggregate counts;
- bounded rejection codes and field paths; and
- sanitized root-cause classification for unexpected failures.

Never log access tokens, user health values, full request/response bodies, or
raw rejected rows. User identifiers should follow the package's existing log
redaction/hash policy.

## Schema, compatibility, and migration

Phase 1 requires no component table or index change. It adds a versioned action
and return type. Existing v1 clients keep their strict request-level behavior.

Expected package change: minor. Replacing v1 semantics in place, weakening its
validator, or changing its response type would be breaking and is not part of
this PRD.

An optional ingestion-receipt table may be considered later only if durable
request-status lookup becomes a demonstrated requirement. Logs and returned
reports are sufficient for the first phase.

## Existing consumer upgrade path

For existing hosts:

1. update the package and deploy the new component code; no schema migration is
   required;
2. keep sending requests to v1 with no behavior change;
3. update one SDK/client integration to understand the v2 report;
4. opt that client into v2 partial mode and monitor rejection codes;
5. fix recurring producer errors before broad rollout; and
6. retain client retry behavior for transport and storage failures.

`../clipin-app` currently relies primarily on Garmin webhook ingestion, so it
does not need to adopt v2 merely to upgrade the package. Any mobile/SDK path can
move independently when it can surface or monitor partial acceptance.

## Acceptance criteria

- One malformed row among valid rows produces `partially_accepted` and stores
  every valid row exactly once.
- Strict mode persists nothing when validation fails.
- V1 behavior and response types are unchanged.
- Request size, row count, and rejection sample limits are enforced.
- A retry after a response timeout does not duplicate accepted data.
- Logs and responses contain no raw health values or credentials.
- Property/fuzz tests cannot cause unbounded parsing, diagnostics, or writes.
- Every rejection code has a documented client action: drop, correct, or retry.

## Open questions

- Should `requestId` be mandatory for v2 or generated when absent?
- Should validation schemas be exported for SDK-side preflight checks?
- Which categories need category-level atomicity rather than row-level partial
  acceptance?
