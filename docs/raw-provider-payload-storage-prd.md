# Raw Provider Payload Storage PRD

## Status

Draft.

## Source Signal

A reference implementation added raw API response and webhook payload storage for Oura and Whoop in March 2026.

## Problem

Provider integrations are difficult to debug after normalization because raw payload shape, missing fields, and provider-specific edge cases are lost.

In Convex, storing raw health payloads directly can be expensive and may hit document size limits, so this needs a more careful design than a direct port.

## Goals

- Provide optional raw payload capture for debugging and replay.
- Avoid storing large health payloads in Convex documents by default.
- Make retention explicit and short by default.
- Keep PII and health data exposure controlled.

## Non-Goals

- Do not enable raw storage by default.
- Do not log raw payloads.
- Do not require a specific blob storage provider in the core component.

## Requirements

- Add optional host config:

```ts
rawPayloadStorage?: {
  enabled: boolean;
  captureProviders?: ProviderName[];
  maxInlineBytes?: number;
  retentionDays?: number;
  store?: FunctionReference<"action", "internal", RawPayloadStoreArgs>;
}
```

- Store only metadata in Convex by default:
  - provider;
  - user id;
  - payload type;
  - hash;
  - byte size;
  - received time;
  - external blob key if available.
- Inline storage must reject payloads above `maxInlineBytes`.
- Add replay only from explicitly stored payloads.

## Data Model

Optional table:

```ts
rawPayloadIngestions: {
  userId: string;
  provider: ProviderName;
  payloadType: string;
  payloadHash: string;
  byteSize: number;
  storageKind: "external" | "inline" | "metadata_only";
  storageKey?: string;
  inlineJson?: string;
  receivedAt: number;
  expiresAt?: number;
}
```

## Existing User Impact

Schema migration required if the table is added.

Recommended npm versioning:

- Minor version if disabled by default.
- Major version only if existing ingestion APIs start requiring raw storage config.

`../clipin-app` impact:

- Should remain disabled in production unless there is a specific support/debug need.
- If enabled, the app must update privacy documentation and retention policy.
- External storage integration should live in the app, not in the component.

## Versioning Guidance

Expected bump: minor (`0.3.0` or later pre-1.0 minor) if raw capture is optional and disabled by default.

Use a major release, or the next pre-1.0 minor with explicit breaking notes, if implementation:

- requires a raw payload storage config for existing provider ingestion;
- stores raw payloads by default;
- changes existing webhook or SDK payload validation;
- introduces mandatory external storage dependencies.

Implementation considerations:

- This requires a Convex schema deploy if `rawPayloadIngestions` is added.
- Keep inline payload limits conservative because Convex documents are size-limited.
- Do not log raw payloads.
- `../clipin-app` should treat this as a privacy-sensitive feature requiring retention and support-process review before production use.

## Migration Plan

No historical migration. Raw payload capture starts after opt-in.

## Open Questions

- Which storage backend should `clipin-app` use if debugging requires raw payloads?
- Should payload replay be admin-only or internal-only?
