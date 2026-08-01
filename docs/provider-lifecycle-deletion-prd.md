---
date: 2026-08-01
status: DONE
priority: P0
semver: minor
target_version: 0.8.0
owner_repo: convex-wearables
---

# Provider Lifecycle and Durable Deletion PRD

## Implementation status

Completed and released in `0.8.0` on 2026-08-01. The component,
typed client API, migration guide, automated tests, and public Fumadocs guide
are implemented. Consumer adoption is outside the completed component scope.

## Summary

Make provider disconnect and health-data deletion explicit, bounded, resumable,
and safe for large accounts. Convex Workflow should own execution durability;
a minimal `dataDeletionOperations` table should hold only stable domain state
that a host application needs to query or audit.

This work separates three operations that must not be conflated:

1. disconnect a local connection without deleting stored health data;
2. revoke or deregister the user at the provider; and
3. delete data for one provider or for the entire component user.

No operation runs automatically merely because a package is upgraded.

## Source signal

Open Wearables added provider-side deregistration for cloud providers in
`069bf3bc` and a provider-scoped "remove all provider data" operation in
`70b3a5b8` in July 2026. Its provider adapters include provider-specific
revocation behavior instead of treating local token removal as equivalent to
remote deregistration.

The current component has `disconnect` and `deleteAllUserData`, but:

- `disconnect` only clears local connection state;
- there is no provider-scoped purge; and
- `deleteAllUserData` loops through all batches in one mutation, so a large
  account can exceed Convex mutation execution limits before any batch commits.

## Decision: Workflow, Workpool, and the operation table

Use Convex Workflow as the deletion orchestrator. It provides durable ordered
steps, retry, restart, cancellation, and terminal status. Workpool remains the
execution mechanism used by Workflow; it is not the public deletion state
model and is insufficient on its own for a cursor-driven, multi-phase purge.

Add a small `dataDeletionOperations` table. This table is not a duplicate task
queue or step journal. It exists because Workflow IDs alone do not provide:

- idempotent lookup for an active deletion by user and scope;
- a stable, reactive host query after Workflow history is cleaned up;
- privacy-audit metadata and final aggregate counts; or
- a user-facing phase and failure summary without exposing internal workflow
  step details.

If the component never exposed progress, idempotency, or an audit result, the
table could be omitted. Account deletion in a consuming app is a strong enough
case to retain this minimal domain record.

## Goals

- Delete provider-scoped or whole-user data in bounded, committed batches.
- Make repeated requests idempotent and safe to resume.
- Support explicit best-effort provider deregistration where the provider API
  supports it.
- Preserve a concise operation result independently of Workflow cleanup.
- Keep local disconnect non-destructive and backward compatible.
- Make every destructive operation deliberate and observable.

## Non-goals

- Do not automatically erase stored data when a connection is disconnected.
- Do not hide destructive behavior behind a boolean option on `disconnect`.
- Do not copy every Workflow step into a component table.
- Do not promise rollback after a deletion batch commits.
- Do not retain deleted health payloads in logs or operation metadata.
- Do not make provider deregistration a prerequisite for local data deletion.

## API semantics

Keep the existing local-only `disconnect` behavior. Add explicit functions with
names that reveal their effects:

```ts
disconnect({ userId, provider })

deregisterProvider({ userId, provider })

startProviderDataDeletion({
  userId,
  provider,
  idempotencyKey,
  deregister?: boolean,
})

startUserDataDeletion({
  userId,
  idempotencyKey,
  deregisterProviders?: boolean,
})

getDataDeletionOperation({ operationId })
getActiveDataDeletionOperation({ userId, provider? })
retryDataDeletion({ operationId })
cancelDataDeletion({ operationId })
cleanupDataDeletionOperation({ operationId })
```

Starting a deletion returns the operation ID and Workflow ID promptly. It does
not hold an action open until all records are gone.

`deregisterProvider` should call the provider API when supported, then clear
local credentials. Provider failure must be classified and reported. A caller
starting deletion may request deregistration, but local deletion must continue
when remote revocation is unsupported or fails permanently; that outcome is
recorded separately.

## Data model

Add one bounded domain table:

```ts
dataDeletionOperations: {
  userId: string;
  scope: "provider" | "user";
  provider?: ProviderName;
  idempotencyKey: string;
  workflowId?: string;
  status: "pending" | "running" | "completed" | "completed_with_warnings" | "failed" | "canceled";
  currentPhase?: string;
  deletedCounts: DataDeletionCounts;
  requestedDeregistration: boolean;
  deregistrationStatus: "not_requested" | "pending" | "completed" | "partially_completed" | "unsupported" | "failed";
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
```

Indexes:

- `by_user_created_at` for history;
- `by_user_status` for active-operation lookup; and
- `by_user_idempotency_key` for deduplication.

Do not store access tokens, provider response bodies, raw records, or a
per-document deletion log. Limit error messages to sanitized summaries.

## Workflow design

The workflow advances through explicit phases, such as:

1. establish the requested scope and mark the operation running;
2. optionally deregister each relevant provider;
3. clear credentials and prevent new sync work for the scope;
4. cancel or fence active sync/backfill work;
5. delete each component table in bounded batches using indexed queries;
6. verify that no scoped rows remain; and
7. write aggregate counts and a terminal operation status.

Each batch mutation deletes at most a configured limit and commits before the
next workflow step. A step must be safe to execute again. Progress is a phase
plus aggregate counts, not a copy of cursors or Workflow internals.

The table order must account for references and data sources. Provider-scoped
deletion removes only records whose provider/data source belongs to the target
connection. Whole-user deletion also removes connection state, summaries,
user-level retention assignments, synthetic data, and earlier deletion
operation records. Deployment-wide provider settings and global retention
rules are preserved. The current operation row is retained until the host calls
`cleanupDataDeletionOperation` after consuming the terminal result.

Cancellation is best effort: it prevents future batches but cannot restore
already deleted data. APIs and documentation must state this plainly.

## Concurrency and idempotency

- Only one whole-user deletion may be active for a user.
- A whole-user deletion supersedes or rejects provider-scoped starts.
- Two provider deletions for the same user/provider resolve to the same active
  operation when the idempotency key matches; otherwise the second is rejected.
- Sync, webhook, and SDK ingestion paths must reject or defer new writes while
  a matching deletion operation is active.
- Deterministic batch selection and repeated empty-batch verification make
  workflow retry safe.

## Backward compatibility and migration

The schema change is additive: one table plus lookup indexes on the new table,
`oauthStates`, and `dailySummaries`. Existing rows need no rewrite. Existing
`disconnect` semantics remain unchanged.

The current synchronous `deleteAllUserData` helper should be deprecated, not
silently redefined with an incompatible return type. Add the workflow-starting
API alongside it for one deprecation cycle. Documentation should warn that the
legacy mutation is suitable only for small/test datasets. A later breaking
release may remove it after consumers migrate.

Expected package change: minor while APIs and schema are additive. Removing or
changing `deleteAllUserData`, making disconnect destructive, or changing its
return contract requires a breaking release under the package's pre-1.0 policy.

## Existing consumer upgrade path

For `../clipin-app`:

1. update the package and deploy the additive component schema;
2. keep existing account-deletion behavior unchanged until the new workflow is
   deployed and verified;
3. replace the direct `deleteAllUserData` call with
   `startUserDataDeletion` and persist or return the operation ID;
4. query the operation to show pending/completed/failed status, or let an
   authenticated backend process wait for the terminal result;
5. remove the app user only after the component deletion reaches the product's
   chosen terminal condition; and
6. define what the app does when remote deregistration fails but local deletion
   succeeds.

Provider "remove data" UI should call the provider-scoped API. A normal
"disconnect" UI should continue to preserve previously synchronized data
unless its copy explicitly says otherwise.

## Acceptance criteria

- A dataset larger than one mutation's safe batch size deletes successfully.
- Killing and restarting the workflow does not skip records or corrupt counts.
- Repeating a start request with the same idempotency key does not create a
  second deletion.
- Provider-scoped deletion cannot remove another provider's rows.
- New scoped ingestion cannot race records back into an active deletion.
- Provider deregistration is tested as success, unsupported, retryable failure,
  and permanent failure.
- Operation records never contain health values, credentials, or raw provider
  responses.
- Existing `disconnect` users observe no destructive behavior change.

## Resolved decisions

- Terminal operation rows remain until explicit host cleanup; the component
  does not assume an audit-retention period.
- Remote deregistration uses bounded Workflow/Workpool retries, then local
  deletion finishes with warnings rather than waiting indefinitely.
- `completed` and `completed_with_warnings` both mean local component deletion
  succeeded. `../clipin-app` should decide whether to surface or separately
  audit provider warnings before deleting its remaining app identity.
