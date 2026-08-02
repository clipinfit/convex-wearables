---
date: 2026-08-01
status: PLANNED
priority: P1
semver: minor
target_version: 0.11.0
owner_repo: convex-wearables
reference_repo: ../open-wearables
---

# Durable Outgoing Events and Self-Service Webhooks PRD

## Summary

Make `convex-wearables` an optional event source as well as a reactive data
store. After a component write commits, consumers should be able to react in
two ways:

1. a host application can receive a typed internal Convex callback for its own
   workflows and side effects; and
2. an authorized tenant administrator or end user of that host application can
   register an HTTPS endpoint and receive signed, filtered webhooks with durable
   retries, delivery history, replay, and endpoint-health controls.

Convex reactive queries already solve UI freshness. This feature is for
imperative and cross-system work: notifications, automation, data pipelines,
partner integrations, user-owned software, and other processing that must
happen after data changes.

The external webhook system must be disabled by default, must never be required
for ingestion success, and must not require Svix. Its behavior should preserve
the useful guarantees demonstrated by Open Wearables and Svix while using
Convex-native transactions, scheduling, actions, Workflow/Workpool primitives,
and component-owned state.

## Product Opportunity

The feature is not only an integration hook for the developer installing the
component. It lets that developer expose safe self-service automation to their
own users.

Examples:

- a user sends each completed workout to a personal training service;
- a clinic or coaching tenant receives consented recovery events for its own
  enrolled users;
- an application triggers a host-owned notification or derived-data workflow;
- a developer streams selected normalized events into a warehouse;
- a user connects a no-code automation endpoint without receiving provider
  credentials or raw provider payloads; and
- an operations system reacts when a sync permanently fails or a connection is
  revoked.

The component provides transport, normalization, delivery state, and safety
boundaries. The host application still owns authentication, authorization,
consent, entitlement, endpoint-management UI, and any promise it makes to its
users or downstream processors.

## Why Convex Reactivity Is Not Enough

Reactive queries update subscribed clients when component data changes. They do
not send an email, call an external endpoint, start an application workflow, or
deliver an event to a system that is not running a Convex query.

Outgoing events complement reactivity:

```text
provider / SDK data
        |
        v
convex-wearables commits normalized data
        |
        +----> reactive queries update UI
        |
        +----> optional internal host callback
        |
        +----> durable outbox -> filtered signed HTTPS webhooks
```

## Open Wearables Reference Behavior

Open Wearables is the behavioral reference, not code to copy directly.

Its current implementation:

- emits connection, sync, workout, sleep, menstrual-cycle, grouped time-series,
  and granular `series.<seriesType>.created` events;
- dispatches asynchronously after data is stored;
- uses a stable event ID for downstream idempotency;
- scopes messages to `user.<user_id>` channels;
- lets a developer create endpoints, filter event types, optionally scope an
  endpoint to one user, retrieve a signing secret, send tests, inspect messages
  and attempts, and replay failures;
- includes time-series samples, splitting batches above 2,500 samples to stay
  below its delivery-provider payload limit;
- disables emission when outgoing webhooks are not configured;
- uses a Celery submission task with late acknowledgement, two retries, and a
  five-second retry delay when submission to Svix fails; and
- delegates endpoint attempts, signatures, history, manual retries, and
  endpoint health to Svix.

Svix's documented default endpoint schedule is: immediately, 5 seconds,
5 minutes, 30 minutes, 2 hours, 5 hours, 10 hours, and another 10 hours. A 2xx
response is success; redirects and other statuses are failures. It supports an
explicit receiver abort response, manual retry/recovery/replay, and disabling
chronically failing endpoints. See the
[Svix retry documentation](https://docs.svix.com/retries).

The Convex implementation should match these user-visible guarantees without
inheriting two weaknesses of the reference implementation:

- failure to enqueue or reach Svix can currently drop an event; and
- a single broadcast task fans out to every developer rather than capturing a
  tenant-scoped event and its deliveries transactionally.

## Goals

- Define a stable, versioned, provider-neutral event contract.
- Preserve a lightweight optional host callback for internal side effects.
- Support component-owned, self-service HTTPS endpoint subscriptions.
- Scope subscriptions to a host tenant and optionally one application user.
- Filter subscriptions by exact event type or documented group.
- Capture webhook events durably through a transactional outbox.
- Deliver at least once with stable idempotency keys and signed payloads.
- Retry failures durably on an escalating schedule with bounded concurrency.
- Expose delivery history, test delivery, manual retry, failure recovery, and
  replay-missing operations.
- Protect health data, endpoint secrets, callback URLs, logs, and network
  egress.
- Integrate endpoint/event/delivery data with user deletion and configurable
  retention.
- Keep the entire feature opt-in and backward compatible.

## Non-Goals

- Do not use webhooks to refresh Convex UI screens; reactive queries already do
  that.
- Do not promise exactly-once delivery or global ordering.
- Do not expose OAuth tokens, Garmin callback URLs, raw provider payloads, raw
  FIT files, or unrestricted component documents.
- Do not make an external webhook response part of an ingestion transaction.
- Do not let the component authenticate an application user directly.
- Do not automatically expose every newly added provider, series type, or
  sensitive data family to existing subscriptions.
- Do not require Svix, although a future adapter may delegate delivery to it.
- Do not provide a complete end-user management UI in this package.

## Ownership and Trust Model

### Component responsibilities

- event catalog and payload versions;
- transactional event capture;
- endpoint and subscription persistence;
- filtering and fan-out;
- signing-secret generation, rotation, and protected storage;
- durable queueing, retry scheduling, concurrency, and terminal state;
- bounded delivery/attempt history and replay primitives;
- SSRF-resistant URL validation and safe HTTP behavior;
- deletion and retention of component-owned webhook state; and
- public client methods and documentation for host wrappers.

### Host application responsibilities

- authenticate the caller;
- establish the stable tenant/developer identifier passed to the component;
- authorize tenant-wide versus user-scoped endpoints;
- prove that the requested application `userId` belongs to the caller;
- enforce plans, feature flags, endpoint counts, and event/data entitlements;
- collect any required user consent and present privacy disclosures;
- expose management routes or UI if self-service webhooks are offered; and
- decide which payload modes and sensitive event families its product allows.

Component methods must be called from authenticated host functions. A browser
must never be allowed to choose an arbitrary tenant ID or user ID and call the
component without a host authorization boundary.

## Two Delivery Modes

### 1. Internal host callback

Retain `onDataSynced` for compatibility and add an optional typed callback:

```ts
onWearablesEvent?: FunctionReference<
  "mutation" | "action",
  "internal",
  WearablesEventEnvelope
>;
```

The callback is useful for host-owned workflows and should receive the same
stable envelope used by external delivery. Dispatch is scheduled after the
data write. A callback failure is isolated from ingestion and follows a short,
bounded retry policy through a dedicated queue.

The callback is not a substitute for durable external deliveries. Hosts that
need audit/replay semantics should use the same endpoint/delivery model or
persist their own receipt before performing side effects.

### 2. External HTTPS webhooks

Authorized principals can manage endpoints through host-wrapped component APIs.
Each endpoint belongs to one `tenantId` and has one of two scopes:

- `tenant`: receives matching events for every user belonging to that tenant;
  only a host-authorized tenant administrator may create it.
- `user`: receives matching events only for one exact application `userId`;
  suitable for end-user self-service integrations.

The component enforces the persisted scope during fan-out. It does not infer
tenant membership and does not accept a broader scope at delivery time.

## Event Contract

### Envelope

Every event uses a stable envelope:

```ts
type WearablesEventEnvelope = {
  id: string;                 // immutable message/event id
  type: WearablesEventType;
  version: 1;
  occurredAt: number;         // unix milliseconds
  tenantId: string;
  userId?: string;
  provider?: ProviderName;
  subject: {
    kind: "connection" | "sync" | "workout" | "sleep" |
      "summary" | "series" | "deletion";
    id?: string;
  };
  idempotencyKey: string;
  data: Record<string, unknown>;
  chunk?: {
    index: number;            // zero based
    count: number;
  };
};
```

The serialized JSON bytes are canonical for signing and retry. A retry must
send the same event ID, body, and semantic timestamp; only delivery-attempt
headers change.

### Initial event catalog

Connection and synchronization:

- `connection.created`
- `connection.status_changed`
- `sync.started`
- `sync.completed`
- `sync.failed`

Semantic records:

- `workout.upserted`
- `workout.enriched`
- `workout.deleted`
- `sleep.upserted`
- `sleep.deleted`
- `summary.upserted`

Time series:

- `series.batch.upserted`
- `series.<seriesType>.upserted`

Lifecycle:

- `data_deletion.started`
- `data_deletion.completed`
- `data_deletion.completed_with_warnings`

Use `upserted`, not `created`, where the current storage path cannot reliably
distinguish an insert from an update. Event naming must describe actual
semantics. A later version may add distinct `created` and `updated` events only
after storage mutations return that distinction deterministically.

### Event groups

The catalog may expose groups for management UIs and broad subscriptions:

- `connection.*`
- `sync.*`
- `workout.*`
- `sleep.*`
- `summary.*`
- `series.*`
- `data_deletion.*`

Groups are expanded to exact versioned event types when a subscription is
saved. This prevents a future sensitive event type from silently entering an
old wildcard subscription. A host or user must explicitly update the endpoint
to receive event types introduced later.

### Payload modes

Endpoints choose one allowed payload mode:

- `reference` (default): identifiers, provider/source attribution, timestamps,
  category/type, counts, and bounded summary metadata. The receiver uses the
  host application's authenticated API when it needs more information.
- `snapshot` (explicit opt-in): includes a documented bounded normalized
  snapshot sufficient for webhook-first processing.

The host configuration determines whether `snapshot` is available at all.
Initial snapshot payloads may include ordinary workout/sleep summary fields and
bounded time-series samples. They must exclude GPS coordinates/routes,
menstrual/pregnancy data, raw sleep stages, credentials, provider payloads,
FIT bytes, and free-form error bodies unless a later reviewed event contract
explicitly adds them.

## Time-Series Payloads and Chunking

Time-series events must be useful without creating unsafe or oversized actions
and HTTP requests.

- The default `reference` event includes series type, provider, source ID,
  count, and start/end timestamps, but no samples.
- An explicitly allowed `snapshot` event may include samples.
- Default maximum: 500 samples and 256 KiB serialized JSON per event.
- Configurable upper bound: 2,500 samples and 512 KiB, matching the useful
  ceiling demonstrated by Open Wearables while staying below common webhook
  gateway limits.
- Larger batches are split into deterministic chunks with `chunk.index` and
  `chunk.count`.
- Every chunk has its own event ID and idempotency key derived from the logical
  batch identity and chunk index.
- Empty, rejected, or policy-discarded samples do not generate misleading
  `series.*.upserted` events.

Receivers must treat chunks independently and must not assume they arrive in
order.

## Data Model

### `outgoingWebhookEndpoints`

```ts
{
  tenantId: string;
  scope: "tenant" | "user";
  userId?: string;
  url: string;
  description?: string;
  eventTypes: string[];       // exact expanded types, never implicit wildcard
  payloadMode: "reference" | "snapshot";
  status: "pending_verification" | "active" | "paused" |
    "disabled" | "deleted";
  encryptedSigningSecret: string;
  signingKeyVersion: number;
  previousEncryptedSigningSecret?: string;
  previousSecretValidUntil?: number;
  consecutiveFailureDays: number;
  firstRecentFailureAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  disabledReason?: string;
  createdAt: number;
  updatedAt: number;
}
```

Indexes:

- `by_tenant_status`
- `by_tenant_user_status`
- `by_status`

Store a normalized URL for equality, but preserve the display form separately
only when necessary. Endpoint queries must never return encrypted secrets.

### `outgoingWebhookEvents`

This is the transactional outbox and canonical replay body.

```ts
{
  tenantId: string;
  userId?: string;
  provider?: ProviderName;
  eventType: string;
  eventVersion: number;
  subjectKind: string;
  subjectId?: string;
  idempotencyKey: string;
  payloadJson: string;        // canonical, bounded serialized envelope
  occurredAt: number;
  fanoutStatus: "pending" | "running" | "completed" | "failed";
  fanoutCursor?: string;
  expiresAt: number;
}
```

Indexes:

- `by_tenant_time`
- `by_idempotency_key`
- `by_fanout_status`
- `by_expiry`

### `outgoingWebhookDeliveries`

One row represents one event-to-endpoint delivery.

```ts
{
  eventId: Id<"outgoingWebhookEvents">;
  endpointId: Id<"outgoingWebhookEndpoints">;
  tenantId: string;
  userId?: string;
  status: "pending" | "delivering" | "retry_scheduled" |
    "succeeded" | "failed" | "canceled";
  attemptCount: number;
  nextAttemptAt?: number;
  lockedAt?: number;
  lastResponseStatus?: number;
  lastErrorCode?: string;
  lastAttemptAt?: number;
  succeededAt?: number;
  failedAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

Indexes:

- `by_event_endpoint` for idempotent fan-out
- `by_status_next_attempt`
- `by_endpoint_status`
- `by_tenant_time`

### `outgoingWebhookAttempts`

Keep bounded operational history outside the delivery row:

```ts
{
  deliveryId: Id<"outgoingWebhookDeliveries">;
  endpointId: Id<"outgoingWebhookEndpoints">;
  attempt: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  outcome: "succeeded" | "retryable_failure" | "permanent_failure";
  responseStatus?: number;
  errorCode?: string;
}
```

Do not store response bodies by default. If a bounded diagnostic preview is
later added, it must be explicitly enabled, capped, treated as untrusted
potentially sensitive data, and covered by retention.

## Transactional Outbox and Fan-Out

When outgoing webhooks are enabled, the mutation that makes a meaningful data
change also inserts the canonical outbox event and schedules fan-out. Convex
scheduler writes participate in the same transaction, so a rolled-back data
write cannot leave a false event and a committed event cannot exist without a
durable fan-out trigger.

External HTTP delivery never runs inside the data mutation.

Fan-out proceeds in bounded pages:

1. claim an outbox event;
2. query active endpoints for its tenant and optional user scope;
3. filter against exact event types and permitted payload mode;
4. insert each `(eventId, endpointId)` delivery idempotently;
5. enqueue delivery work in a dedicated bounded pool;
6. persist the fan-out cursor; and
7. mark fan-out complete only after a final empty-page check.

If external webhooks are disabled or no matching endpoint exists, data writes
continue normally and no delivery row is created. A disabled endpoint never
receives newly created deliveries.

## Durable Delivery Queue

Use a dedicated outgoing-webhook Workpool, or an equivalently isolated durable
queue, rather than sharing the general sync/deletion workflow concurrency.
Network-heavy endpoint calls must not starve provider ingestion, deletion, FIT
processing, or maintenance.

Recommended defaults:

- maximum 10 concurrent endpoint requests per component deployment;
- maximum 2 concurrent requests per endpoint;
- optional tenant-level rate limit;
- 15-second request timeout;
- no redirects;
- one HTTP request per delivery attempt;
- compare-and-set claim from `pending`/`retry_scheduled` to `delivering`;
- reclaim a stale `delivering` lease after a documented timeout; and
- at-least-once delivery.

The durable delivery row is the domain state. Workpool or Workflow metadata is
execution machinery and must not be the only place a host can inspect delivery
status.

## Retry Policy

The default schedule mirrors Svix/Open Wearables endpoint behavior:

| Attempt | Delay after preceding failure | Approximate elapsed time |
|---:|---:|---:|
| 1 | immediate | 0 |
| 2 | 5 seconds | 5 seconds |
| 3 | 5 minutes | 5 minutes, 5 seconds |
| 4 | 30 minutes | 35 minutes, 5 seconds |
| 5 | 2 hours | 2 hours, 35 minutes |
| 6 | 5 hours | 7 hours, 35 minutes |
| 7 | 10 hours | 17 hours, 35 minutes |
| 8 | 10 hours | 27 hours, 35 minutes |

Each retry is persisted as `retry_scheduled` with `nextAttemptAt`, then
scheduled durably. A scheduler invocation is only a wake-up signal; the action
must re-read and atomically claim current delivery state before sending.

Classification:

- HTTP 200–299: success.
- network/DNS/TLS errors, timeout, HTTP 3xx, 408, 425, 429, and 5xx: retry while
  attempts remain.
- other HTTP 4xx: retry by default for compatibility with the reference
  behavior, but record the status distinctly so operators can fix endpoint
  configuration.
- HTTP 410: permanent failure and endpoint disable, unless future evidence
  requires a different contract.
- response header `webhook-delivery: abort-message`: permanent failure for that
  message, mirroring Svix delivery control.
- a bounded valid `Retry-After` on 429 or 503 may postpone the next attempt, but
  never beyond the configured maximum delay or event expiry.

After attempt 8, mark the delivery `failed`. Never retry forever. Manual retry
creates a new attempt on the same delivery and reuses the same event ID/body.

### Endpoint health

Track failure history across messages, not only one delivery. By default,
disable an endpoint after failures span five consecutive days and include
multiple failed messages separated by at least 12 hours. A success resets the
consecutive failure window. Hosts may pause or re-enable an endpoint manually.

Disabling an endpoint cancels its scheduled pending deliveries. Re-enabling it
does not silently replay missed events; the caller chooses an explicit replay
window.

## Delivery Semantics

- Delivery is at least once.
- Events may arrive more than once and out of order.
- Different endpoints progress independently.
- One failing endpoint cannot delay or fail another endpoint.
- A stable `idempotencyKey` lets receivers deduplicate business processing.
- The receiver should persist the event ID before performing non-idempotent
  side effects.
- A 2xx response means the receiver accepted responsibility for the event, not
  necessarily that all downstream work finished synchronously.
- No event contract should require a receiver to hold the HTTP request open for
  long work.

FIFO delivery may be explored later for endpoints that explicitly choose the
throughput trade-off. It is not the default.

## Signing and Secret Management

Every external request includes:

```text
wearables-id: <event id>
wearables-timestamp: <unix seconds>
wearables-signature: v1,<base64 hmac-sha256>
wearables-attempt: <1-based attempt>
wearables-event-type: <event type>
```

Sign the exact raw request body using:

```text
HMAC-SHA256(endpointSecret, "<id>.<timestamp>.<rawBody>")
```

Receiver documentation must require raw-body verification, constant-time
signature comparison, and a default five-minute timestamp tolerance.

Requirements:

- generate at least 32 random bytes per endpoint;
- return the plaintext secret only at creation or explicit rotation;
- store the secret encrypted with a deployment-provided master key;
- fail closed when external webhooks are enabled without the encryption key;
- never return encrypted secret material from normal endpoint queries;
- redact secrets from logs and errors;
- support rotation with a bounded overlap window in which old and new
  signatures are both sent or verifiable; and
- document master-key rotation and recovery before implementation ships.

If component runtime constraints prevent safe secret encryption, external
delivery must use a host-provided signer/delivery function or audited external
delivery service. Plaintext component-owned signing secrets are not an
acceptable silent fallback.

## Endpoint Registration and Network Security

Endpoint creation starts in `pending_verification`. Activation requires a
successful signed test/challenge or an explicit privileged host override.

Production URL rules:

- HTTPS only;
- no URL credentials or fragments;
- reject localhost names and `.local` domains;
- reject loopback, private, link-local, multicast, unspecified, and reserved IP
  literals;
- resolve and validate DNS at registration and again at delivery;
- reject redirects rather than following them;
- normalize internationalized domains before validation;
- restrict ports by default, with an explicit host allowlist for exceptions;
- revalidate the URL after every endpoint update; and
- never log query strings, which may contain receiver secrets.

DNS rebinding must be considered. If the Convex runtime cannot validate the
resolved destination safely at request time, use an egress proxy or
host-provided delivery action that can. Do not claim SSRF protection based only
on string checks of the hostname.

Endpoint URLs are confidential operational metadata. Return them only through
tenant-authorized management APIs and redact query parameters in routine
status views.

## Management API Surface

Expose typed `WearablesClient` methods intended to be wrapped by authenticated
host functions:

```ts
createWebhookEndpoint(ctx, {
  tenantId,
  scope,
  userId?,
  url,
  description?,
  eventTypes,
  payloadMode?,
}) // returns endpoint plus one-time signing secret

listWebhookEndpoints(ctx, { tenantId, userId?, cursor?, limit? })
getWebhookEndpoint(ctx, { tenantId, endpointId })
updateWebhookEndpoint(ctx, { tenantId, endpointId, ...changes })
pauseWebhookEndpoint(ctx, { tenantId, endpointId })
resumeWebhookEndpoint(ctx, { tenantId, endpointId })
rotateWebhookSecret(ctx, { tenantId, endpointId })
deleteWebhookEndpoint(ctx, { tenantId, endpointId })
sendWebhookTest(ctx, { tenantId, endpointId, eventType? })

listWearablesEventTypes(ctx)
listWebhookEvents(ctx, { tenantId, userId?, cursor?, limit? })
listWebhookDeliveries(ctx, { tenantId, endpointId?, status?, cursor?, limit? })
listWebhookAttempts(ctx, { tenantId, deliveryId, cursor?, limit? })
retryWebhookDelivery(ctx, { tenantId, deliveryId })
recoverFailedWebhookDeliveries(ctx, { tenantId, endpointId, since })
replayMissingWebhookEvents(ctx, { tenantId, endpointId, since, until? })
```

All list methods are cursor-paginated and bounded. Bulk recover/replay methods
must create a durable operation with progress and limits; they must not scan an
unbounded date range inside one action.

The component does not mount unauthenticated public management HTTP routes.
Each host decides whether to expose Convex functions, REST endpoints, an
application portal, or no self-service management at all.

## Endpoint Limits and Abuse Controls

Provide safe component ceilings and let hosts impose stricter plan limits:

- maximum endpoints per tenant;
- maximum endpoints per user;
- maximum exact event types per endpoint;
- maximum replay window and events per replay operation;
- maximum delivery bytes;
- maximum requests per endpoint and tenant per minute;
- maximum active recovery operations; and
- maximum retained event/attempt history.

Do not let an end user turn the component into an arbitrary HTTP request relay.
Only persisted catalog events can be delivered, using POST, the fixed header
set, and the persisted endpoint URL.

## Privacy, Consent, and Data Minimization

Webhook delivery exports health data outside the host's Convex deployment. The
host must treat endpoint creation as a data-sharing action.

Requirements:

- external webhooks are globally disabled by default;
- user-scoped subscriptions require host-verified user authorization;
- tenant-wide subscriptions require elevated host authorization;
- `reference` payloads are the default;
- snapshot payloads require explicit host enablement and endpoint selection;
- newly introduced sensitive event types never enter existing group
  subscriptions automatically;
- provider credentials, callback URLs, raw payloads, raw files, and unrestricted
  error text are categorically excluded;
- location, menstrual/pregnancy, and similarly sensitive families require a
  later dedicated review;
- logs use IDs, event types, status codes, durations, and safe error codes—not
  payload bodies or full endpoint URLs; and
- documentation tells hosts to update privacy disclosures, processor terms,
  consent flows, and data-export/deletion behavior as appropriate.

The component supplies technical controls. It cannot determine whether a host
has a lawful basis or user consent for a particular downstream endpoint.

## Deletion and Retention

### User/provider deletion

Durable user deletion must:

1. fence new event creation for the deletion scope;
2. cancel pending/retrying deliveries containing that user's data;
3. delete user-scoped endpoints when the user is deleted;
4. delete or redact user-scoped event payloads and attempt metadata;
5. preserve tenant-wide endpoint configuration while removing that user's
   queued data; and
6. complete before connection/data-source deletion removes lookup paths.

Provider-scoped deletion removes provider-specific queued events and deliveries
but does not delete a user endpoint that also subscribes to other providers.

Do not emit health-data deletion webhooks after local deletion has begun unless
the deletion event contains only approved lifecycle metadata. A deleted user's
health snapshot must never remain available merely for webhook replay.

### Default retention

- canonical outbox payloads: 30 days;
- successful deliveries and attempts: 7 days;
- failed deliveries and attempts: 30 days;
- deleted endpoint tombstone/idempotency metadata: up to 30 days;
- endpoint configuration: until explicit deletion, tenant deletion, or
  user deletion for user-scoped endpoints.

Retention is bounded maintenance work with expiry indexes and batch limits.
Hosts may choose shorter periods. Increasing payload retention beyond defaults
requires explicit configuration and privacy/storage review.

## Failure and Recovery Scenarios

### Component restarts after scheduling

The delivery row remains the source of truth. A repeated scheduler invocation
atomically claims or no-ops, so duplicate wakes are safe.

### Worker dies during HTTP request

The `delivering` lease expires. The next recovery scan returns the row to
`retry_scheduled`. The same event ID/body is sent again, producing at-least-once
behavior.

### Endpoint succeeds but acknowledgement is lost

The request may be repeated. Receiver idempotency is required.

### Fan-out stops midway

The outbox cursor and `(eventId, endpointId)` identity let fan-out resume
without duplicate delivery rows.

### Webhooks are disabled

No external delivery is attempted. Existing endpoint configuration is retained
unless explicitly removed. Re-enabling does not replay missed data
automatically.

### Configuration or encryption key is missing

External delivery fails closed and exposes a safe configuration status. Core
wearable ingestion remains available. Secrets are never written unencrypted as
a fallback.

## Observability

This feature includes focused delivery observability even though general
unified sync observability remains deferred.

Expose:

- endpoint status and last success/failure timestamps;
- event fan-out state;
- delivery status, attempt count, next retry, and safe failure code;
- attempt timestamps, response status, and duration;
- counts of pending, retrying, failed, and disabled endpoints; and
- durable recover/replay operation progress.

Do not expose raw response bodies, payloads, secrets, full URLs, or unrestricted
receiver error messages in general operational views.

## Implementation Phases

### Phase A: contracts and transactional outbox

- Finalize event catalog, envelope, group expansion, payload modes, and limits.
- Add event/outbox schema and lifecycle retention/deletion.
- Emit events atomically from event, summary, series, connection, sync, workout
  enrichment, and deletion paths.
- Keep all external delivery disabled.

### Phase B: internal host callback

- Add `onWearablesEvent` without removing `onDataSynced`.
- Use isolated bounded retry handling.
- Document at-least-once/idempotency semantics.

### Phase C: endpoint management and signing

- Add endpoint CRUD, exact event filtering, user/tenant scope, verification,
  one-time secret return, rotation, and host wrapper examples.
- Add safe configuration status and endpoint limits.

### Phase D: durable external delivery

- Add fan-out, dedicated Workpool, delivery claims/leases, signing, HTTP safety,
  the eight-attempt schedule, attempt history, and automatic endpoint disable.
- Add focused load, SSRF, secret-redaction, and restart/retry tests.

### Phase E: self-service recovery

- Add test events, history queries, manual retry, recover failed, and replay
  missing operations.
- Add Fumadocs guides for senders, host authorization, and receivers.

The phases may ship together in one minor release only if the entire external
surface meets the acceptance criteria. Do not expose endpoint creation before
durable delivery, signing, SSRF protection, deletion, and retention are ready.

## Migration and Existing Consumer Upgrade Path

Expected release: `0.11.0`, assuming workout enrichment ships as `0.10.0`.

This is a minor release because all APIs and schema are additive and outgoing
delivery is disabled by default.

Schema additions:

- `outgoingWebhookEndpoints`
- `outgoingWebhookEvents`
- `outgoingWebhookDeliveries`
- `outgoingWebhookAttempts`
- optionally a small durable recovery-operation table if bulk replay needs
  stable host-visible progress

No existing health-data row requires rewriting. Existing consumers update the
package and deploy the component schema. They need no environment variables,
routes, callbacks, or endpoint migrations while the feature remains disabled.

To enable internal callbacks, a consumer adds `onWearablesEvent` while retaining
`onDataSynced` during the compatibility period.

To enable external delivery, a consumer must additionally:

1. configure the signing-secret encryption key and external-delivery switch;
2. deploy authenticated host wrappers for endpoint management;
3. define tenant and user authorization rules;
4. choose allowed payload modes and event families;
5. review privacy/consent, retention, support, and abuse limits;
6. test one endpoint and receiver signature verification; and
7. enable self-service management gradually.

Rollback is code-safe while new tables remain in the schema and delivery is
disabled. If delivery has been enabled, disable new fan-out first, drain or
cancel pending deliveries according to documented policy, and retain additive
tables until secrets, events, and attempts are intentionally disposed.

## Versioning Guardrails

Remain a minor release only if:

- all new behavior is disabled by default;
- `onDataSynced` remains supported;
- existing ingestion semantics remain compatible;
- no environment variable becomes mandatory for consumers that do not enable
  external webhooks; and
- schema changes accept every document written by supported earlier versions.

A major release is required if implementation makes event capture mandatory in
a way that changes ingestion availability, removes `onDataSynced`, changes
existing callback arguments incompatibly, or exposes previously excluded data
to existing subscriptions.

## Testing Strategy

### Contract and idempotency

- Every event has a stable ID, type, version, timestamp, subject, and
  idempotency key.
- Retrying source ingestion creates no duplicate logical event or delivery row.
- Group subscriptions expand only to event types known at save time.
- Payload and chunk limits are enforced by count and serialized bytes.

### Authorization and isolation

- Tenant A cannot read or mutate Tenant B endpoints, events, deliveries, or
  attempts.
- A user-scoped endpoint receives only its exact user.
- A tenant endpoint receives only its tenant.
- Host wrapper examples reject arbitrary tenant/user scope supplied by clients.

### Delivery and retry

- 2xx succeeds once.
- redirects, timeouts, DNS/TLS failures, 4xx, 429, and 5xx follow the documented
  classification.
- all eight scheduled attempts survive action failure and process restart.
- `Retry-After` is parsed and bounded.
- abort and 410 responses stop the correct delivery.
- stale leases recover safely.
- one endpoint failure does not affect another endpoint.
- manual retry and replay preserve the original event ID/body.

### Security

- signatures verify against exact raw bytes and fail after body mutation.
- timestamp tolerance and secret rotation overlap work as documented.
- secrets and URL query strings never appear in logs or ordinary query results.
- HTTP URLs, credentials, fragments, redirects, private IPs, DNS rebinding, and
  disallowed ports fail closed.
- arbitrary methods, headers, and bodies cannot be injected through endpoint
  registration.

### Privacy and lifecycle

- provider deletion cancels and removes only matching provider deliveries.
- user deletion removes user endpoints, payloads, deliveries, and attempts in
  bounded batches.
- tenant endpoints survive one user deletion without retaining that user's
  queued payloads.
- retention removes expired payload and attempt rows without deleting active
  endpoint configuration.
- disabled external delivery does not prevent normal ingestion.

### Compatibility and load

- existing consumers with no webhook configuration behave exactly as before.
- `onDataSynced` and `onWearablesEvent` coexist.
- fan-out, delivery, and retry are bounded under many tenants/endpoints.
- delivery work cannot starve sync, deletion, FIT processing, or time-series
  maintenance.

## Documentation Requirements

Before release, publish high-quality package and Fumadocs documentation for:

- architecture and the difference between reactivity, callbacks, and webhooks;
- event catalog and versioning policy;
- host authorization and self-service integration patterns;
- endpoint CRUD, filtering, payload modes, limits, and retention;
- signing and raw-body verification examples;
- retry schedule, delivery semantics, idempotent receiver design, and replay;
- SSRF/network restrictions and endpoint verification;
- privacy, consent, user deletion, and provider deletion;
- migration from `onDataSynced`; and
- operational troubleshooting without exposing health payloads or secrets.

## Acceptance Criteria

- Core ingestion remains usable with outgoing delivery disabled or
  misconfigured.
- Enabled event capture uses a transactional outbox and cannot emit false events
  for rolled-back writes.
- Internal callbacks and external endpoints consume one versioned event
  contract.
- Tenant and user endpoint scopes are enforced from persisted authorization
  decisions.
- Every external request is HTTPS, signed, bounded, redirect-free, and protected
  against SSRF to the extent required by the approved delivery architecture.
- Delivery is at least once with stable IDs and the documented eight-attempt
  durable retry schedule.
- Endpoint failures are isolated; terminal failures are inspectable and
  manually recoverable.
- Secrets are returned once, stored encrypted, rotatable, and absent from logs
  and ordinary queries.
- User/provider deletion and retention remove webhook payloads and delivery
  state in bounded durable phases.
- Existing consumers require only package update and schema deployment unless
  they explicitly enable callbacks or external webhooks.
- Tests cover contracts, fan-out, retries, restart recovery, authorization,
  signing, SSRF, deletion, retention, limits, and backwards compatibility.
- README, `UPGRADING.md`, API reference, receiver guide, and Fumadocs are
  complete before publication.

## Decisions to Finalize Before Implementation

1. Whether direct component actions can perform DNS/IP validation safely enough
   or external delivery requires a host egress action/proxy.
2. Whether the component will implement envelope encryption directly or require
   host-provided encrypt/decrypt functions.
3. Whether `tenantId` should be a generic string or a host-defined opaque
   namespace plus application ID.
4. Whether snapshot payloads ship in the first release or reference-only is the
   safer initial external contract.
5. Whether callback dispatch and external delivery share one dedicated pool or
   use separate concurrency budgets.
6. The exact retention ceilings and whether hosts may increase them.
7. Whether a future Svix adapter should coexist with native delivery behind the
   same component contracts.
