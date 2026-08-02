---
date: 2026-08-01
status: IMPLEMENTED
priority: P1
semver: minor
target_version: 0.11.0
owner_repo: convex-wearables
reference_repo: ../open-wearables
---

# Polar, Suunto, and WHOOP Live Provider Webhooks PRD

> **Implementation status:** Complete for the planned `0.11.0` minor release.
> The package now contains the opt-in routes, dedicated durable receipt
> workflow, WHOOP v2 targeted update/delete processing, Polar `EXERCISE`
> registration and targeted processing, Suunto targeted/inline processing,
> operator APIs, bounded cleanup, deletion integration, tests, README and
> upgrade guidance, and Fumadocs documentation. Publishing remains a separate
> operator action.

## Final implementation decisions

- Webhook processing uses a second installed Workflow/Workpool component with
  maximum parallelism 5 and four action attempts using 1-second exponential
  backoff. It cannot consume the pull/deletion workflow budget.
- The default raw body limit is 512,000 bytes, capped at 1,000,000 by the route
  helper. Suunto accepts at most 5,000 inline samples per notification.
- WHOOP verification reuses the stored OAuth client secret. Polar's one-time
  signing secret and Suunto's notification secret live in the component-owned
  registration row and are excluded from public queries.
- WHOOP targeted recovery uses the v2 resource identifier and stable
  `whoop-recovery-<resource>-<series>` external IDs.
- Polar initially subscribes only to `EXERCISE`; incomplete Polar data families
  are rejected at registration instead of being silently discarded.
- Successful/ignored payloads are redacted immediately. Failed receipt payloads
  and metadata expire within seven days; unknown-connection payloads use the
  shorter 15-minute race window.
- WHOOP, Polar, and Suunto ship together because the shared foundation and each
  provider's documented first-release scope are complete.

## Summary

Add opt-in inbound webhook ingestion for Polar, Suunto, and WHOOP. These
provider callbacks should make newly created, updated, or deleted wearable data
appear sooner than the next scheduled pull while preserving pull sync as the
reconciliation and recovery path.

The webhook request path must do only bounded work:

1. read the raw request body;
2. verify the provider-specific signature or handshake;
3. validate a small notification envelope;
4. persist or deduplicate a durable receipt and schedule processing; and
5. acknowledge the provider promptly.

Provider API calls, normalization, database writes, and retries happen after
acknowledgement in a durable Convex Workflow/Workpool path.

This work is independent of
[outgoing-webhooks-prd.md](./outgoing-webhooks-prd.md). Incoming provider
webhooks bring source data into the component. Outgoing webhooks notify a host
or its users after component data changes. Neither feature requires the other.

## Problem

The component currently supports pull adapters for Polar, Suunto, and WHOOP,
but it has no inbound routes for their live notifications. A consumer must wait
for a manual or periodic sync even when a provider can announce data changes in
near real time.

Treating a webhook as merely a request to run the existing broad sync is also
insufficient:

- duplicate delivery can launch redundant syncs;
- a provider retry can arrive after newer data;
- provider signatures are different and operate on the raw request bytes;
- WHOOP and Polar notifications identify one resource that can be fetched
  directly;
- Suunto can include 24/7 samples in the notification itself;
- deletion notifications require an exact, user-scoped delete rather than a
  date-window pull;
- a successful HTTP acknowledgement does not mean downstream ingestion has
  completed; and
- provider delivery is not a complete history and must not replace periodic
  reconciliation.

## Product Outcome

When enabled for a provider:

- a new workout or sleep normally appears soon after the provider publishes it;
- duplicate notifications are harmless;
- temporary Convex or provider API failures are retried locally after the
  provider has been acknowledged;
- deletes remove the exact normalized resource and its component-owned child
  data;
- operators can inspect bounded receipt status without storing health payloads
  indefinitely; and
- disabling or not mounting the webhook route leaves current pull behavior
  unchanged.

## Source Findings

### Open Wearables

The local Open Wearables reference implements a shared provider-webhook
pipeline with provider-specific handlers. Its useful behaviors are:

- signature verification before payload processing;
- immediate acknowledgement followed by asynchronous queue processing;
- lookup of a connection by provider-side user identity;
- targeted resource fetching for notify-only providers;
- provider-specific handling of update and delete events;
- duplicate-safe normalized writes; and
- pull support alongside webhook delivery.

Open Wearables currently uses Celery for the queue. This component should carry
over the behavior, not the infrastructure: Convex durable workflows,
transactional scheduling, component tables, and isolated Workpool concurrency
are the local equivalents.

### Polar AccessLink

Polar webhooks are application-level notifications. Important official
constraints:

- one webhook can be registered per Polar API client;
- creation or URL update sends a `PING` request that must receive HTTP 200;
- the initial creation PING arrives before the caller receives the newly issued
  signing secret, so the endpoint needs a narrowly validated PING exception;
- creation returns a `signature_secret_key` only once;
- normal payloads are signed with HMAC-SHA256 over the raw request body and the
  signature is provided in `Polar-Webhook-Signature`;
- payloads include an event, Polar user ID, entity ID, timestamp, and usually a
  Polar URL for the entity;
- supported documented events include exercise, sleep, continuous heart rate,
  activity summary, physical information, and SleepWise data;
- delivery expects HTTP 200; and
- Polar automatically deactivates a webhook after seven days of unsuccessful
  delivery.

Reference: [Polar AccessLink webhooks](https://www.polar.com/accesslink-api/#webhooks).

### WHOOP

WHOOP webhooks are notify-only and configured per application webhook URL in
the WHOOP developer dashboard. Important official constraints:

- v2 is the current/default model and uses UUID resource IDs;
- legacy v1 webhook events are no longer published;
- event types are `workout.updated`, `workout.deleted`, `sleep.updated`,
  `sleep.deleted`, `recovery.updated`, and `recovery.deleted`;
- create operations are represented by `*.updated`;
- recovery v2 uses the associated sleep UUID as its notification ID;
- signatures use HMAC-SHA256 over the timestamp header concatenated with the
  exact raw body, base64 encoded, using the app client secret;
- the headers are `X-WHOOP-Signature` and
  `X-WHOOP-Signature-Timestamp`;
- a notification contains identity and change metadata, not the changed health
  record, so the component must fetch the resource through the v2 API;
- `trace_id` can be used for duplicate detection;
- WHOOP retries failed delivery five times over roughly one hour and recommends
  acknowledgement within one second; and
- WHOOP explicitly warns that notifications can be duplicated or missed and
  recommends a reconciliation pull.

Reference: [WHOOP webhooks](https://developer.whoop.com/docs/developing/webhooks/).

### Suunto

Suunto webhook URLs and a notification secret are configured in the Suunto API
Zone application settings. Important official constraints:

- payloads use a `username` value corresponding to the Suunto OAuth user;
- requests are signed with HMAC-SHA256 over the exact request body in
  `X-HMAC-SHA256-Signature`;
- the endpoint must return a successful response within two seconds;
- supported notifications include new workouts, routes, 24/7 activity, sleep,
  and recovery data;
- 24/7 payloads include sample arrays inline;
- a workout notification contains an identifier that can be used to fetch the
  canonical workout through the Workout API; and
- Suunto retries with exponential backoff, but repeated application failures
  can activate a provider-side circuit breaker for all notifications.

Reference: [Suunto webhook notifications](https://suunto-api.developer.azure-api.net/webhooks).

## Goals

- Add secure, opt-in inbound routes for Polar, WHOOP v2, and Suunto.
- Acknowledge authenticated requests only after a durable receipt is committed
  and processing is scheduled transactionally.
- Use one shared receipt/processing framework with provider-specific adapters.
- Fetch only the affected resource when the provider contract supports it.
- Normalize through the same functions and tables used by pull sync.
- Apply existing ingestion fences during provider or user deletion.
- Make duplicates, retries, reordering, and unknown users safe.
- Support exact user/provider-scoped deletion notifications.
- Keep scheduled pull reconciliation enabled and documented.
- Expose provider capability and registration state without exposing secrets.
- Preserve existing behavior when no new routes are mounted.

## Non-Goals

- Do not implement outgoing host or end-user webhooks.
- Do not replace historical or scheduled pull sync.
- Do not promise exactly-once processing or strict notification ordering.
- Do not build a provider-management dashboard in the component.
- Do not expose provider webhook routes automatically during package upgrade.
- Do not ingest Suunto routes until the component has a provider-neutral route
  model.
- Do not add WHOOP v1 support to a new implementation.
- Do not retain raw health payloads as an analytics or debugging archive.
- Do not broaden Polar data coverage silently: event types without an existing
  normalized storage path may be acknowledged and marked unsupported until
  that data capability is implemented.

## Architectural Principles

### Webhook receipt is a signal, not the source of truth

For notify-only providers, the provider API response is authoritative. For
Suunto inline samples, normalized storage remains authoritative after a
successful write. Periodic pull reconciliation repairs missed notifications
where the provider offers corresponding pull APIs.

### Acknowledge after durable acceptance

Returning 2xx before durable capture can lose an event if scheduling fails.
Perform one internal mutation that inserts or deduplicates the receipt and
schedules its processor in the same Convex transaction. Return 2xx only after
that mutation succeeds.

If signature validation fails, return 401 or 403 and do not persist the body.
If durable acceptance fails, return 5xx so the provider can retry.

### Isolate webhook work

Use a dedicated provider-webhook workflow manager or Workpool concurrency
budget. Webhook-triggered network calls must not starve scheduled sync,
deletion, Garmin FIT processing, or retention maintenance.

Recommended initial defaults:

- maximum 5 concurrently processing receipts per deployment;
- maximum 1 active receipt per connection where practical;
- at most 4 local action attempts;
- 1-second initial retry backoff with factor 2 for transient action failures;
- provider `Retry-After` honored within a bounded ceiling; and
- terminal receipt failure retained for operator inspection and reconciliation.

The exact retry behavior may reuse the existing durable workflow defaults, but
the concurrency budget should be isolated before enabling high-volume Suunto
24/7 callbacks.

## Request Pipeline

```text
provider POST
    |
    v
host-mounted component HTTP action
    |
    +-- read bounded raw bytes
    +-- provider-specific signature verification
    +-- minimal envelope validation
    |
    v
transaction: dedupe/insert receipt + schedule processor
    |
    +-- failure -> 5xx, provider retries
    |
    +-- success/duplicate -> provider-specific 2xx
                            |
                            v
                 dedicated durable processor
                            |
                 resolve active connection
                            |
       targeted fetch / inline normalization / exact delete
                            |
                            v
                  existing normalized tables
```

## Shared Webhook Adapter Contract

Add an internal provider-webhook adapter rather than embedding provider logic in
one HTTP file:

```ts
type ProviderWebhookAdapter = {
  provider: "polar" | "whoop" | "suunto";
  verify(request: Request, rawBody: Uint8Array, settings: WebhookSettings):
    Promise<VerificationResult>;
  parse(rawBody: Uint8Array): ProviderWebhookNotification;
  deriveIdempotencyKey(notification: ProviderWebhookNotification,
    rawBodyDigest: string): string;
  resolveConnectionIdentity(notification: ProviderWebhookNotification):
    { providerUserId?: string; providerUsername?: string };
  process(ctx: ProviderWebhookContext,
    notification: ProviderWebhookNotification): Promise<ProcessingResult>;
};
```

Provider-specific types remain private. The public package should expose route
handlers, route-registration helpers, capability metadata, and safe status
types—not raw provider payload unions as a permanent compatibility promise.

## Data Model

### `providerWebhookReceipts`

Add a component-owned table for durable acceptance and bounded operational
state:

```ts
{
  provider: "polar" | "whoop" | "suunto";
  idempotencyKey: string;
  eventType: string;
  providerUserId?: string;
  providerUsername?: string;
  resourceId?: string;
  providerTraceId?: string;
  payloadJson: string;
  payloadDigest: string;
  receivedAt: number;
  expiresAt: number;
  status: "pending" | "processing" | "waiting_for_connection" |
    "completed" | "ignored" | "failed" | "canceled";
  attempt: number;
  connectionId?: Id<"connections">;
  workflowId?: string;
  completedAt?: number;
  resultCode?: string;
  errorCode?: string;
}
```

Required indexes:

- unique-by-convention lookup on `(provider, idempotencyKey)`;
- processing/recovery lookup on `(status, receivedAt)`;
- retention lookup on `expiresAt`; and
- connection lifecycle lookup on `(connectionId, status)`.

`payloadJson` exists only because Suunto can deliver inline samples and durable
processing needs the exact accepted data. Enforce a strict request-size limit
before insert. Retention must remove payloads quickly; logs and status APIs must
never return them.

### `providerWebhookRegistrations`

Store application-level webhook configuration and lifecycle separately from
per-user connections:

```ts
{
  provider: "polar" | "whoop" | "suunto";
  status: "unconfigured" | "pending_verification" | "active" |
    "paused" | "deactivated" | "error";
  targetUrl?: string;
  remoteId?: string;
  modelVersion?: "v2";
  eventTypes?: string[];
  webhookSecret?: string;
  configuredAt?: number;
  lastVerifiedAt?: number;
  lastReconciledAt?: number;
  lastErrorCode?: string;
  updatedAt: number;
}
```

There is at most one row per provider per component deployment. Polar's
one-webhook-per-client rule makes this application-scoped rather than
connection-scoped.

`webhookSecret` is sensitive and must never be returned by ordinary queries.
Polar's value must be persisted in the same operation that handles a successful
create response because Polar does not expose it again. WHOOP verification uses
the already stored client secret. Suunto uses its independently configured
notification secret.

If implementation can avoid storing Suunto's notification secret in component
state by using a host-provided secret resolver without weakening route
ergonomics, document that option. Do not create a second uncontrolled plaintext
copy merely for convenience.

## Idempotency and Ordering

Provider delivery is at least once. Component processing must therefore be
idempotent at two levels:

1. receipt deduplication prevents duplicate workflow fan-out; and
2. normalized storage upserts by provider-scoped external identity.

Keys:

- WHOOP: `whoop:v2:<trace_id>` when present; otherwise hash
  `(type,user_id,id,rawBodyDigest)`.
- Polar: hash `(event,user_id,entity_id,timestamp)`; `PING` is not a health-data
  receipt.
- Suunto workout: `(type,username,workoutKey)`.
- Suunto 24/7: hash `(type,username,sample timestamp range,rawBodyDigest)`.
- Unknown future Suunto payload: raw-body digest under the provider namespace.

Never rely only on arrival order. Update events fetch the provider's current
resource state, so an older notification arriving later should still converge
to current provider data. Delete processing must be exact and idempotent.

## Connection Resolution and Lifecycle

- Polar and WHOOP resolve using `(provider, providerUserId)`.
- Suunto resolves using `(provider, providerUsername)`; add an index for this
  lookup rather than scanning connections.
- Only active connections may accept new normalized writes.
- The existing user/provider ingestion fence is checked again during the
  storage mutation, not only during receipt processing.
- A valid notification for a revoked/deleting connection is acknowledged and
  marked `ignored_connection_inactive` or `canceled_by_deletion`.

A valid notification can race OAuth completion. If no connection exists,
retain the bounded receipt in `waiting_for_connection` and retry locally for a
short window, recommended 15 minutes. After that, mark it ignored and let the
next reconciliation pull recover any available data. Do not retain unknown-user
health payloads for a long retry horizon.

If the component later supports shared provider accounts, connection resolution
must fan out safely as described in
[shared-provider-accounts-prd.md](./shared-provider-accounts-prd.md). This
release preserves the current single-connection lookup behavior.

## Provider-Specific Requirements

### WHOOP v2

#### Route and verification

- Export an opt-in POST handler for a host-mounted WHOOP v2 route.
- Read the exact body bytes once.
- Require both WHOOP signature headers.
- Validate the HMAC against `timestampHeader + rawBody` using the provider
  client secret and constant-time comparison.
- Reject timestamps outside a documented replay window, recommended five
  minutes, while allowing a configurable bounded clock-skew tolerance.
- Enforce WHOOP v2 identifiers as strings/UUIDs; do not silently coerce the
  route into legacy v1 semantics.

#### Updates

- `workout.updated`: fetch `/v2/activity/workout/{uuid}`, normalize with the
  existing WHOOP workout normalizer, and upsert.
- `sleep.updated`: fetch `/v2/activity/sleep/{uuid}`, normalize with the
  existing sleep normalizer, and upsert.
- `recovery.updated`: treat the notification ID as the associated sleep UUID,
  fetch the supported WHOOP v2 recovery resource, normalize points and summary
  fields, and upsert with stable external IDs.

Add targeted provider-adapter methods rather than running a broad date-window
sync for these events. The same normalizers must serve targeted and pull paths.

#### Deletes

- Workout and sleep delete operations must match `(user, provider,
  providerResourceId)` and remove component-owned workout enrichment children.
- Recovery points need stable external IDs that encode the WHOOP
  recovery/sleep resource so `recovery.deleted` can remove only matching points
  and refresh or remove the affected daily summary.
- A missing local record is a successful idempotent no-op.

#### Reconciliation

Keep periodic pull sync enabled. WHOOP explicitly documents possible missing
webhooks. Capability metadata should describe live webhook plus REST pull, not
webhook-only mode.

### Polar

#### Registration lifecycle

Provide explicit application-level management actions:

```ts
createPolarWebhook({ targetUrl, eventTypes })
getPolarWebhookStatus()
updatePolarWebhook({ targetUrl?, eventTypes? })
activatePolarWebhook()
deactivatePolarWebhook()
deletePolarWebhook()
reconcilePolarWebhookRegistration()
```

These actions are component functions; a host decides whether and how to wrap
them with operator authorization. They are not end-user operations.

Creation must:

1. mark local registration pending;
2. call Polar with application credentials;
3. accept the exact creation-time `PING` handshake at the mounted route even
   though the newly issued secret is not yet available to the receiver;
4. persist the returned remote ID and one-time signing secret atomically after
   a successful response; and
5. expose only safe active/error status.

Concurrent create attempts must be serialized or deduplicated because Polar
allows only one webhook per API client. Reconciliation must handle the case
where the remote webhook exists but local state is incomplete. If the one-time
secret was lost, the safe recovery path is remote delete and controlled
re-creation.

#### Route and verification

- Accept unsigned payloads only when the parsed body is the exact documented
  `PING` shape required for creation/update verification.
- Require `Polar-Webhook-Signature` for every non-PING payload.
- Verify HMAC-SHA256 over the raw body with the stored one-time secret.
- Require event header and body event to agree when both are present.
- Never fetch the arbitrary `url` field directly without validation.

For targeted fetches, prefer constructing an allowlisted Polar API path from
the validated event and entity ID. If the provider URL must be used, require
HTTPS, exact Polar AccessLink host, no credentials, no redirect, and an
allowlisted path prefix.

#### Event rollout

Initial implementation should enable only events with complete normalized
storage support:

1. `EXERCISE`;
2. `SLEEP` after the Polar adapter gains its corresponding normalizer; and
3. other Polar types individually after their pull/normalization path exists.

Do not subscribe to all documented Polar events and then silently discard
them. Registration event types must reflect actual component capability.

#### Health and reconciliation

- Track local registration state and periodically compare it with Polar.
- Surface provider deactivation without exposing secrets.
- An operator action may reactivate after the route health problem is fixed.
- Keep scheduled Polar pulls available even while webhook status is active.

### Suunto

#### Route and verification

- Export an opt-in POST handler.
- Verify `X-HMAC-SHA256-Signature` over exact body bytes using the configured
  notification secret and constant-time comparison.
- Persist and schedule before returning 2xx, within Suunto's two-second limit.
- Apply a strict total body limit and a separate maximum sample count.

#### Events

- `WORKOUT_CREATED`: derive the workout key, fetch the canonical single workout
  with the subscription key, normalize through the existing Suunto function,
  and upsert.
- `SUUNTO_247_SLEEP_CREATED`: validate and normalize bounded inline samples.
- `SUUNTO_247_ACTIVITY_CREATED`: validate and normalize bounded inline
  heart-rate, steps, energy, and other already supported metrics.
- `SUUNTO_247_RECOVERY_CREATED`: validate and normalize bounded recovery
  samples.
- `ROUTE_CREATED`: acknowledge and mark ignored until a provider-neutral route
  model exists.
- Unknown event types: acknowledge authenticated notifications and mark them
  unsupported; do not return repeated 5xx for a contract the installed package
  cannot process.

Per-sample validation should isolate malformed samples where safe so one bad
sample does not discard the entire valid batch. This should follow the partial
ingestion principles already established for SDK ingestion.

#### Circuit-breaker protection

Because repeated failures can pause all Suunto notifications for the
application, keep request handling independent of provider fetches and heavy
normalization. Once a valid request is durably accepted, return success even if
later processing reaches a terminal local failure. Scheduled pull
reconciliation and failed-receipt recovery handle that failure locally.

## Exact Delete Safety

Before WHOOP delete events ship, replace any generic external-ID deletion path
used by webhooks with an identity-scoped mutation. It must require:

- component `userId`;
- provider;
- normalized resource category where relevant; and
- provider-derived external ID.

The mutation must verify the event's `dataSourceId` belongs to that user and
provider before deleting. It must also remove dependent workout segments,
zones, activity-file job references, or future enrichment children using the
same bounded lifecycle guarantees.

Webhook payload data must never be allowed to name another user's record solely
by external ID.

## HTTP Responses

Use provider-compatible responses while keeping a common policy:

| Condition | Response | Receipt |
|---|---:|---|
| valid Polar PING | 200 | registration verification only |
| valid and durably accepted | provider-compatible 2xx | pending or duplicate |
| valid duplicate | provider-compatible 2xx | existing receipt |
| valid unsupported event | 2xx | ignored/unsupported |
| valid unknown/inactive user | 2xx after bounded receipt | waiting or ignored |
| malformed JSON/schema | 400 | none |
| missing/invalid signature | 401 or 403 | none |
| body too large | 413 | none |
| durable acceptance unavailable | 500/503 | none; provider should retry |

Do not disclose whether a provider user exists in the HTTP response.

## Error Classification and Local Retries

- provider 408, 425, 429, 5xx, network, DNS, TLS, and timeout failures:
  retry durably within the configured local attempt budget;
- provider 401 after token refresh failure: use existing structured token
  classification and mark the connection expired only when definitive;
- provider 403/404 for the targeted resource: re-read connection/event state,
  then treat confirmed deletion/unavailability as an idempotent terminal result;
- malformed accepted payload discovered during processing: terminal failed or
  ignored, without retrying forever;
- missing connection: bounded `waiting_for_connection` retry;
- user/provider deletion fence: cancel or ignore, never retry ingestion through
  the fence; and
- worker interruption: the durable workflow resumes or fails visibly, and the
  receipt remains recoverable.

Provider delivery retries and component processing retries are separate. Once
the component has durably accepted a valid notification, later local failure
must not intentionally cause repeated provider delivery.

## Retention and Privacy

Webhook receipts can contain health data, especially Suunto inline samples.

Recommended defaults:

- completed/ignored receipt payload: redact or delete after processing, then
  delete metadata after 7 days;
- failed receipt payload: retain at most 7 days for controlled retry;
- unknown-user payload: delete after the 15-minute connection-race window;
- registration metadata: retain while configured;
- signing secrets: retain only while the registration is active or needed for
  safe cleanup; and
- no raw payload body, access token, signing secret, or health sample in logs or
  public status queries.

Provider deletion must cancel pending receipts for that connection/provider.
Whole-user deletion must cancel and remove all user-resolved receipts before
connections are removed. Unresolved receipts are bounded by their short expiry
and provider identity; lifecycle cleanup should also remove those that can be
matched safely.

This receipt-specific lifecycle is part of the webhook feature. It does not
depend on the separate semantic event-retention roadmap item.

## Public API and Route Mounting

Export provider-specific handlers or a typed mount helper while keeping routes
opt-in. Illustrative host configuration:

```ts
registerWearablesRoutes(http, components.wearables, {
  webhooks: {
    polar: { path: "/wearables/webhooks/polar" },
    whoop: { path: "/wearables/webhooks/whoop/v2" },
    suunto: { path: "/wearables/webhooks/suunto" },
  },
});
```

Exact API shape can follow existing component conventions, but it must ensure:

- upgrading does not mount a new public route automatically;
- each provider can be enabled independently;
- routes use raw body bytes for signature verification;
- safe registration/receipt status is queryable by authenticated host wrappers;
  and
- secret-bearing management actions remain internal or explicitly operator
  controlled.

Suggested status surface:

```ts
getProviderWebhookStatus({ provider })
listProviderWebhookReceipts({ provider?, status?, cursor?, limit? })
retryProviderWebhookReceipt({ receiptId })
cancelProviderWebhookReceipt({ receiptId })
```

Manual retry must revalidate lifecycle state and must not bypass the maximum
payload-retention window.

## Capability Metadata

Provider capability metadata should distinguish:

- `restPull`;
- `webhookStream` for inline/provider-push data;
- `webhookPing` for notify-then-fetch behavior;
- `webhookRegistrationApi`;
- `webhookInboundSecret`;
- supported live event families; and
- reconciliation support.

Expected values after implementation:

| Provider | Pull | Live model | Registration | Verification |
|---|---|---|---|---|
| WHOOP | yes | notify then targeted fetch | dashboard | app client secret + timestamped HMAC |
| Polar | yes | notify then targeted fetch | AccessLink API, one per client | one-time webhook secret + HMAC |
| Suunto | yes | inline 24/7 plus targeted workout fetch | API Zone settings | notification secret + HMAC |

Capability metadata describes what the installed component implements, not
everything a provider theoretically offers.

## Implementation Order

### Phase A: shared durable receipt foundation

- Add receipt and registration tables and indexes.
- Add provider-webhook adapter types.
- Add transactional accept/deduplicate/schedule mutation.
- Add isolated durable processor, retry classification, cleanup, and status.
- Add scoped exact-delete primitives.
- Add route-size limits, secret-safe logging, and lifecycle fencing.

### Phase B: WHOOP v2

Recommended first provider because its public v2 contract is explicit and the
component already normalizes workouts, sleep, and recovery.

- Add raw-body signature verification and replay-window checks.
- Add v2 payload validation and trace-ID deduplication.
- Add targeted workout, sleep, and recovery provider methods.
- Add exact workout/sleep/recovery delete support.
- Retain periodic reconciliation sync.

### Phase C: Polar

- Add PING and signed notification route behavior.
- Add registration lifecycle actions and one-time secret persistence.
- Add exercise targeted fetch first.
- Add sleep/other events only with matching normalized adapter support.
- Add remote/local registration reconciliation and reactivation handling.

### Phase D: Suunto

- Add HMAC route and strict body/sample bounds.
- Add targeted canonical workout fetch.
- Add partial-safe inline 24/7 sample ingestion.
- Add circuit-breaker-conscious acknowledgement and reconciliation.

### Phase E: release hardening

- Add cleanup scheduling and failed-receipt recovery.
- Add capability metadata and route documentation.
- Run provider contract fixtures and high-volume duplicate tests.
- Publish Fumadocs guides, API reference, troubleshooting, and upgrade notes.

The provider order is a delivery recommendation, not a requirement to publish
all three simultaneously. Each phase can ship as a backward-compatible minor
release if its public scope is complete and documented.

## Migration and Existing Consumer Upgrade Path

Expected release: `0.11.0` if provider-neutral workout enrichment is released
as `0.10.0` and outgoing webhooks remain deferred. Version numbers are assigned
by actual release order; no PRD reserves a version permanently.

This is a minor release when:

- tables and indexes are additive;
- route mounting remains opt-in;
- provider credentials accept existing shapes;
- pull sync remains supported; and
- no currently enabled route changes behavior incompatibly.

Schema additions:

- `providerWebhookReceipts`;
- `providerWebhookRegistrations`; and
- a `connections` index for `(provider, providerUsername)` if required for
  efficient Suunto lookup.

No existing health-data row requires rewriting. Existing consumers that do not
enable live provider webhooks should:

1. update the package;
2. deploy the additive component schema; and
3. make no route, environment, or provider-dashboard changes.

To enable a provider, a generic consumer should:

1. update and deploy the package/schema;
2. configure current provider credentials and any notification secret;
3. mount only that provider's HTTPS route;
4. test signature verification and durable acceptance;
5. configure or register the provider callback;
6. verify registration state and a real event;
7. retain scheduled pull reconciliation; and
8. monitor failed receipts before expanding rollout.

Rollback:

- disable or unregister the provider callback first;
- keep pull sync enabled;
- allow already accepted receipts to finish or cancel them explicitly;
- unmount the route only after provider delivery is stopped; and
- retain additive tables until their bounded retention cleanup completes.

## Versioning Guardrails

Use a minor version for the planned additive, opt-in implementation.

A major version is required if implementation:

- mounts externally reachable routes automatically;
- makes provider webhook configuration mandatory for existing pull users;
- removes pull sync or changes its default behavior incompatibly;
- changes existing credential arguments in a non-backward-compatible way;
- changes existing external-ID semantics without a compatibility migration; or
- causes accepted webhook work to compete with and materially alter existing
  workflow availability by default.

A patch is not appropriate because live ingestion routes, management actions,
capabilities, and schema tables are new public functionality.

## Testing Strategy

### Shared contract

- raw body is read once and the verified bytes equal persisted bytes;
- valid receipt insertion and scheduling are transactional;
- scheduling failure returns 5xx without a false accepted receipt;
- duplicate idempotency keys return 2xx and start no duplicate workflow;
- malformed, oversized, invalid-signature, and unknown event cases follow the
  response matrix;
- workflow interruption and action retry preserve receipt state;
- provider concurrency cannot starve unrelated durable workflows; and
- logs/status results redact bodies and secrets.

### WHOOP

- official v2 UUID fixtures for every update/delete event;
- valid, missing, malformed, mismatched, and stale signatures;
- constant-time signature comparison;
- `trace_id` duplicate delivery;
- targeted fetch and normalization for workout, sleep, and recovery;
- recovery ID interpreted as sleep UUID;
- exact user/provider-scoped deletion, including enrichment children;
- provider retry/429 and token-refresh classification; and
- reconciliation restores a deliberately missed notification.

### Polar

- unsigned exact PING accepted while other unsigned payloads fail closed;
- registration create stores the one-time secret and remote ID;
- interrupted registration can reconcile or safely recreate;
- only one concurrent create wins;
- event header/body mismatch fails;
- valid and invalid HMAC fixtures;
- arbitrary payload URL cannot trigger SSRF;
- each subscribed type has a targeted normalized processing path; and
- remote deactivation and local reactivation status are represented safely.

### Suunto

- official workout, activity, sleep, recovery, and route fixtures;
- HMAC over exact bytes and invalid signature rejection;
- two-second-compatible durable acknowledgement benchmark;
- maximum body and sample-count enforcement;
- duplicate workout and duplicate sample batches;
- malformed sample isolation;
- unknown username connection-race handling;
- targeted workout fetch with subscription key; and
- downstream terminal failure does not cause provider retry amplification.

### Lifecycle and compatibility

- provider deletion cancels pending matching receipts;
- whole-user deletion cannot be followed by a late webhook write;
- unknown-user payload expires quickly;
- pull-only existing consumers behave identically after schema deployment;
- no new environment value is required while routes are disabled; and
- old normalized records remain readable with no rewrite.

## Documentation Requirements

Before release, update the package README, `UPGRADING.md`, API reference, and
Fumadocs site with:

- inbound provider webhooks versus outgoing consumer webhooks;
- architecture and durable acknowledgement semantics;
- one setup guide per provider;
- exact callback URL and dashboard/registration steps;
- provider secrets and signature verification behavior;
- WHOOP v2-only support;
- event-type coverage and intentionally unsupported events;
- duplicate, ordering, and reconciliation guarantees;
- pull fallback recommendations;
- receipt status, retry, retention, and troubleshooting;
- user/provider deletion interaction; and
- upgrade, staged enablement, and rollback instructions.

Documentation must not imply that installing the package exposes routes or
registers callbacks automatically.

## Acceptance Criteria

- Each enabled route rejects unauthenticated payloads before persistence.
- Authenticated requests are acknowledged only after transactional durable
  acceptance.
- Provider API work and health-data writes occur outside the HTTP request path.
- Duplicate and reordered notifications converge safely.
- WHOOP uses only the v2 webhook/resource model.
- Polar registration preserves its one-time signing secret and one-webhook
  application constraint.
- Suunto processing meets its fast acknowledgement requirement and protects
  against application-wide circuit-breaker amplification.
- Updates reuse provider normalizers shared with pull sync.
- Deletes are exact, user/provider scoped, idempotent, and include dependent
  component records.
- Pull reconciliation remains available and documented for all three providers.
- Webhook receipt payloads have bounded retention and never appear in public
  status or logs.
- Routes remain disabled until explicitly mounted and configured.
- Full tests, typecheck, lint, build, package dry run, and documentation review
  pass before an operator publishes the release.

## Decisions to Finalize Before Implementation

1. Whether one shared workflow component can provide genuinely isolated
   webhook concurrency or a second installed Workflow/Workpool component is
   required.
2. Exact request-body and per-notification sample limits based on verified
   provider production payload sizes.
3. Whether provider registration secrets remain in component tables under the
   existing credential model or use a host secret-resolver boundary.
4. The exact WHOOP recovery-by-sleep targeted endpoint behavior and stable
   external-ID representation.
5. Which Polar event types beyond `EXERCISE` have complete enough normalized
   adapter support for the first Polar release.
6. Whether successful receipt metadata needs seven days of retention or a
   shorter default is sufficient.
7. Whether Polar, WHOOP, and Suunto ship in one minor release or as separate
   provider-complete minor releases.
