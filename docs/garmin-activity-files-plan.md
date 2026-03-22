---
date: 2026-03-22
status: NOT_IMPLEMENTED
---

# Garmin Activity Files Support Plan for `convex-wearables`

## Summary
- Add opt-in Garmin Activity Files ingestion to extract detail that is not available in the current `activities` or `activityDetails` JSON feeds.
- Keep the first milestone focused on the main product gap: strength workout detail such as exercises, sets, reps, and load when present in the file.
- Reuse the existing Garmin webhook endpoint, but do not download or parse files inline in the webhook request.
- Do not require object storage in v1. Download the file, parse the high-value detail, persist normalized data, then discard the raw bytes.
- Treat raw file archival as an optional later capability for reprocessing and debugging, not as a mandatory dependency of the base component.

## Why This Is Needed
- Current Garmin workout ingestion stores only summary-level fields in `events`.
- Garmin `activityDetails` can add richer generic sensor streams, but the local Garmin Activity API docs do not document strength-specific sets, reps, or weights in that JSON model.
- The Garmin Activity API docs explicitly position Activity Files as the path for data that may not be exposed in parsed Activity Details.
- The initial product goal is therefore clear: use Activity Files to close the strength workout detail gap first, then decide whether broader sport coverage is worth the added complexity.

## Garmin API Findings

### Activity Files behavior
- Garmin does not push the raw FIT, TCX, or GPX bytes to our server.
- Garmin sends a notification payload with an `activityFiles` array. Each item includes metadata plus a `callbackURL`.
- We must call the `callbackURL` ourselves to download the file.
- The callback URL is valid for 24 hours only.
- Garmin documents that the callback URL should be downloaded once; duplicate downloads can return HTTP 410.
- The callback URL token is not the user's OAuth token and should be treated as a short-lived secret.

### Scope of files
- The docs say Activity Files provide Garmin-original activities created by Garmin devices, plus manual uploads.
- This suggests we should not assume every activity in the summary feed will always have an associated downloadable raw file.

### Why files matter for strength
- In the local Activity API docs, `activityDetails` documents samples, laps, GPS, power, cadence, and related streams.
- It does not document exercise-level strength structure such as sets, reps, load, or exercise names.
- In the local Training API docs, Garmin documents `exerciseCategory`, `exerciseName`, and `weightValue`, but that is for workout import into Garmin, not completed activity export.
- Activity Files are therefore the most plausible source for completed strength detail.

### Backfill findings
- The backfill section explicitly includes Activity File in the user rate limit and historic support policy.
- The same section documents `GET /wellness-api/rest/backfill/activities` as the resource for both activity summaries and activity files.
- It does not document a separate `backfill/activityFiles` endpoint.
- This is important but slightly ambiguous. Before we design a strong operational promise around reprocessing, we should verify in Garmin UAT that enabling Activity Files and calling `backfill/activities` actually produces `activityFiles` notifications.

## Product Goals
- Capture strength workout detail that is missing today.
- Keep Garmin webhook acknowledgements fast and reliable.
- Avoid adding mandatory external storage dependencies to the component.
- Reuse existing component architecture where it helps.
- Keep the design open to other activity types later without forcing a giant generic schema on day one.

## Non-Goals for v1
- Do not store every raw FIT sample or every GPS point from every sport.
- Do not force users to configure Cloudflare R2 or another object store.
- Do not promise full generic support for all FIT record types in the first release.
- Do not redesign the existing `events` table to hold deep workout structure.

## Recommended Direction

### 1. Make Activity Files explicitly opt-in
- Add a dedicated Garmin Activity Files feature flag in component configuration.
- Do not tie feature enablement to object storage credentials.
- If Activity Files are disabled, the webhook should still return HTTP 200 and skip processing.
- If Activity Files are enabled, the component should process files even when no raw-file archival backend is configured.

### Why this is better than gating on R2
- Your current preference is not to require R2 unless it proves operationally necessary.
- If we gate processing on R2 credentials, we turn an optional backup/debug feature into a hard requirement.
- The cleaner design is:
  - `activityFiles.enabled` controls whether we process files at all.
  - `activityFiles.rawStorage` is optional and only controls whether raw files are retained after download.

### 2. Reuse the existing Garmin webhook path
- Keep using the current Garmin webhook route.
- Extend payload detection so the same endpoint can accept `activityFiles` notifications alongside the existing Garmin payload types.
- The routing and authentication surface stays simple for host apps and for Garmin portal configuration.

### 3. Do not process files inside the webhook request
- The callback URL is one-time and expires quickly, but file download and parsing are still too heavy and failure-prone to do synchronously in the HTTP handler.
- The webhook request should:
  - validate and decode payload
  - dedupe and persist minimal queue records
  - enqueue async processing
  - return HTTP 200 quickly

This is the right place to be strict about acknowledgement semantics and loose about heavy downstream work.

### 4. Use a dedicated async processing pipeline
- Prefer a durable workflow per activity file item.
- The processing steps are naturally multi-stage:
  - accept notification
  - claim job
  - download file via callback URL
  - parse file
  - map normalized detail
  - upsert persistent data
  - scrub short-lived secrets
  - finalize status
- A durable workflow is a better fit than ad hoc inline actions because it gives retry semantics, state visibility, and room for future branching.

### Concurrency recommendation
- Avoid letting file downloads and FIT parsing compete directly with normal sync and backfill workflows if the workflow pool is shared.
- If the current durable workflow manager would cause contention, isolate Activity File processing with its own concurrency limit.
- This matters because Activity File processing is network-heavy and may be CPU-heavy depending on parser choice.

## Storage Recommendation

### Recommended v1: no mandatory raw file storage
- Download the file, parse it, extract the normalized data we care about, then discard the raw bytes.
- This keeps the component simpler and avoids introducing a hard dependency on R2 or another object store.
- It also aligns with the current product goal, which is not archival but richer normalized activity detail.

### Why this is reasonable
- Garmin docs suggest historic activity file data is covered by backfill policy.
- If that holds in practice, the source of truth remains Garmin rather than our own object store.
- For a reusable Convex component, avoiding required bucket configuration is a real product advantage.

### Caveat
- Garmin's duplicate-backfill semantics are not fully clear from the local docs.
- If repeated replays of the same time window are hard to trigger, raw archival may become useful later for deterministic reprocessing.
- That is a good reason to design the pipeline so optional archival can be added later without changing the core ingestion model.

### Future optional raw storage
- Keep raw archival as a later extension, not part of the first milestone.
- If added later, it should be:
  - optional
  - provider-specific to Garmin
  - separate from provider credentials
  - usable for debugging, reprocessing, or incident recovery

## Queue and Retention Model

### Use an ephemeral inbox/job table
- Add a dedicated table for Garmin Activity File processing jobs.
- Store only the minimum data needed to process and observe the file:
  - provider user id
  - resolved connection id and app user id when available
  - `summaryId`
  - `activityId`
  - `fileType`
  - `manual`
  - `startTimeInSeconds`
  - `callbackURL`
  - status
  - attempts
  - workflow id
  - received timestamp
  - expiry timestamp
  - parser version
  - last error

### Treat callback URLs as sensitive and short-lived
- The callback URL should not live forever in the database.
- After a successful download, scrub the callback URL from the row.
- After terminal failure or expiry, scrub it as well.

### TTL behavior
- Convex does not give us table TTL as a schema primitive.
- The practical equivalent is:
  - store `expiresAt`
  - schedule cleanup for expired or completed rows
  - keep only non-sensitive metadata if we want short operational history

### Retention recommendation
- Keep the sensitive callback URL only while the file is still downloadable.
- Keep lightweight job metadata longer if useful for debugging and monitoring.
- If maximum simplicity is preferred, delete completed rows shortly after success and expired rows shortly after failure.

## Data Model Recommendation

### Keep summary events and deep detail separate
- Do not extend the `events` table to hold deep strength structure.
- `events` should remain the summary-level cross-provider event table.
- Activity File output should live in separate tables that can evolve without destabilizing the core summary schema.

### Recommended shape
- One processing/audit table for Garmin Activity File jobs.
- One long-lived detail table keyed to the workout event or Garmin activity id.

### What the long-lived detail table should hold in v1
- A provider-neutral normalized strength detail payload, keyed to a Garmin workout event.
- This payload can include:
  - exercise order
  - exercise label or category
  - set order
  - reps when present
  - load and unit when present
  - duration-based set info when present
  - rest markers when present
  - parser metadata and provenance

### Why not create many sport-specific tables immediately
- We do not yet know how consistently Garmin FIT files expose all desired structures across devices and activity types.
- The first real value is strength data.
- It is safer to learn from real FIT files before committing to a broad permanent schema for laps, GPS tracks, swim intervals, cycling segments, and every other sport-specific detail.

### How to stay future-friendly
- Keep the detail record provider-neutral in concept, even if Garmin is the only source initially.
- Support a `detailKind` or similarly explicit classification so later phases can add:
  - `strength`
  - `laps`
  - `sport_segments`
  - `raw_summary_extensions`

## Parsing Scope

### FIT-first is the right first step
- If the goal is strength workout detail, FIT should be the first supported file type.
- TCX and GPX are much less likely to give meaningful strength-specific structure.
- A practical v1 can:
  - fully support FIT
  - mark TCX and GPX as skipped or unsupported
  - keep room to add broader coverage later

### Only extract high-value missing data
- Do not parse and persist every file record just because it exists.
- Focus on what materially improves the product beyond current Garmin ingestion:
  - strength exercises
  - sets
  - reps
  - load
  - rest structure

### Secondary future opportunities
- If the FIT parser work proves worthwhile, later phases can consider:
  - laps or splits for endurance sports
  - summary fields not currently stored, like pace, cadence, elevation loss, elapsed time
  - sport-specific detail that is not already covered by `activityDetails`

### Explicitly avoid full sample ingestion in v1
- Pulling every FIT sample into `dataPoints` would create storage and query pressure immediately.
- That work should be evaluated together with the separate time-series retention policy effort, not smuggled into the first Activity Files release.

## Matching Files to Existing Events
- Current Garmin events are keyed from `activityId`.
- Activity File notifications also include `activityId`, which makes them linkable to the summary event.
- We should not assume file notifications and activity summary notifications arrive in a fixed order.

### Recommended linking behavior
- Use `activityId` as the stable cross-feed linkage key.
- Allow a file job to exist before the corresponding summary `event` row exists.
- If the summary event is missing, the processor can:
  - parse the file anyway
  - persist normalized detail keyed by Garmin activity id
  - attach or reconcile to the `event` row later when present

This avoids fragile ordering assumptions between `activities`, `activityDetails`, and `activityFiles`.

## Backfill Strategy

### Recommendation
- Do not assume a separate `activityFiles` backfill type yet.
- Validate in Garmin UAT whether enabling Activity Files and calling `backfill/activities` produces `activityFiles` notifications.

### If UAT confirms that behavior
- Reuse the existing Garmin backfill surface.
- Treat Activity Files as another webhook output that arrives as a side effect of Garmin activity backfill.
- No new public backfill API may be needed at first.

### If UAT does not confirm that behavior
- Revisit whether we need:
  - a Garmin-specific replay story
  - optional raw archival
  - a different operational model for reprocessing

### Important operational caution
- The docs mention duplicate backfill requests can be rejected with HTTP 409.
- We should not promise easy repeated replay of the same time window until we verify Garmin's exact behavior in practice.

## Failure and Retry Behavior
- Duplicate notifications should be deduped by a stable Garmin file identity, not by callback URL alone.
- A file should only be downloaded once after a successful claim.
- Retry download and parsing failures only while the callback URL is still valid.
- If the callback URL has expired, mark the job as expired rather than retrying indefinitely.
- Unsupported file types should be marked as skipped, not failed.
- If Activity Files are disabled, return HTTP 200 and skip processing without creating noisy failed jobs.

## Security Considerations
- Do not expose callback URLs or raw file bytes to client APIs.
- Do not persist Garmin callback tokens longer than necessary.
- Avoid storing `userAccessToken` from the Activity Files notification unless we discover a concrete need for it.
- Prefer minimal persistence of Garmin-supplied secrets.

## Rollout Plan

### Phase 0: UAT validation
- Enable Activity Files in Garmin UAT on the existing webhook path.
- Record real Garmin strength workouts on supported devices.
- Confirm that downloaded FIT files actually contain the strength detail we want.
- Confirm whether `backfill/activities` also regenerates Activity Files notifications.
- Confirm delivery and duplication behavior under retries.

### Phase 1: infrastructure
- Add Activity Files payload detection to the Garmin webhook handler.
- Add the ephemeral inbox/job table.
- Add async workflow-based processing.
- Add FIT download and parser abstraction.
- Add status and cleanup behavior.

### Phase 2: strength extraction
- Extract normalized strength workout detail.
- Link that detail to the existing workout event model.
- Add tests around ordering, dedupe, expiry, and unsupported file types.

### Phase 3: targeted expansion
- Consider lap-level or split-level detail for run, ride, and swim only if there is product demand.
- Reassess optional raw archival only if Garmin backfill is not sufficient for operational recovery.

## Main Risks
- Real-world FIT files may not expose strength structure as consistently as hoped across devices.
- Callback URLs are time-limited and single-use, so queue durability and dedupe matter.
- Heavy file processing may compete with current sync and backfill concurrency if not isolated.
- Garmin backfill behavior for Activity Files is not fully clear from the local docs.
- Broad sport support could quickly expand scope if we do not keep the first milestone narrow.

## Recommendation
- Implement Garmin Activity Files as an opt-in, FIT-first, strength-first feature.
- Reuse the existing Garmin webhook path, but enqueue file notifications immediately into a dedicated async processing flow.
- Do not make R2 or any other object store a hard dependency in v1.
- Persist only the normalized detail that adds clear product value, not the raw file by default.
- Validate Garmin backfill behavior in UAT before making archival or replay decisions that depend on it.
