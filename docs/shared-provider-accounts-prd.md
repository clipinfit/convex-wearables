---
date: 2026-07-18
status: PROPOSED
priority: P3
semver: minor
owner_repo: convex-wearables
activation: product-requirement-required
---

# Shared Provider Accounts PRD

## Summary

Support one external provider account linked to multiple host-app users without
duplicate provider API calls or silent webhook loss. This is intentionally
deferred until a product requirement defines consent, ownership, disconnect,
and deletion semantics.

## Problem

`connections.by_provider_user` can contain more than one connection, but current
webhook resolution selects only the first row. Pull syncs are coordinated per
component connection rather than per provider identity. If shared identities
exist, secondary users may miss webhook data and concurrent pulls can duplicate
provider requests.

## Product decisions required before implementation

- Is sharing permitted in production or only test/research environments?
- Does each host user explicitly consent to receiving the external account's
  data?
- Who is allowed to disconnect or revoke the shared provider authorization?
- Does deleting one host user delete only its copied data?
- What happens when the provider identity changes after reconnection?
- May one user's retention policy differ from another user's policy for copied
  provider data?

## Goals

- Fan out one inbound webhook to every active authorized connection.
- Parse a provider payload once, then write independently and idempotently per
  host user.
- Deduplicate concurrent pulls/backfills by provider identity.
- Expose linked-account sync provenance without leaking other users' identity.
- Preserve per-user deletion, retention, and read isolation.

## Non-goals

- Do not infer sharing merely because provider user IDs collide.
- Do not expose linked host-user IDs through the public component API by
  default.
- Do not share Apple/Health Connect/Samsung SDK-push identities.
- Do not share component documents directly between users.

## Proposed architecture

- Replace single-row webhook lookup with a bounded query for all active
  connections matching `(provider, providerUserId)`.
- Normalize inbound payload once in the action, then invoke isolated per-user
  mutations so one duplicate/failure does not roll back other users.
- Add `sharedSyncLeases` keyed by provider identity and sync scope, with expiry,
  owner connection, and workflow ID.
- Elect one pull/backfill workflow as primary. Secondary requests attach to the
  active lease or report a linked/deduplicated result.
- Never store access tokens on the lease. Token ownership remains on a
  connection and must be selected by an explicit rule.
- Include non-identifying `sharedProviderSync: true` and primary workflow ID in
  operational metadata, not another user's app ID.

## Failure semantics

- A webhook is acknowledged after fan-out work is durably scheduled.
- Failure for one user is retried independently.
- A stale lease can be claimed only after expiry and workflow-status checks.
- Revocation from the provider marks every connection for that provider
  identity revoked if the revoked credential is shared.
- Host-requested disconnect affects only that host connection unless the host
  explicitly requests provider-level deregistration and policy permits it.

## Migration and existing-user impact

Expected schema change: an additive `sharedSyncLeases` table and optional sync
metadata fields. The existing provider-user index is already non-unique.

- No existing connection or health-data row needs rewriting.
- No host-run data migration is required.
- Existing installations keep current single-account behavior until the feature
  is explicitly enabled.
- Before enablement, an audit query must identify duplicate active
  `(provider, providerUserId)` groups so operators understand existing state.
- Rollback disables new lease creation; additive rows can expire naturally.

For `../clipin-app`, package/schema deployment alone is insufficient. CLIPIN
must first define consent, disconnect, privacy, and deletion behavior. Keep this
feature disabled until those product decisions and user-facing flows exist.

## Acceptance criteria

- One webhook reaches all and only active authorized linked users.
- One provider pull occurs for concurrent linked sync requests.
- No cross-user query can read another user's copied data.
- Disconnect and deletion follow the approved product policy.
- Lease expiry and workflow crash recovery are deterministic and tested.
- Existing single-connection users behave exactly as before.
