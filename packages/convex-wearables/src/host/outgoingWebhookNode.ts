"use node";

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { OutgoingWebhookHostRequest } from "../client/outgoingWebhookProtocol.js";
import type { ComponentApi } from "../component/_generated/component.js";

const KEY_ENV = "CONVEX_WEARABLES_WEBHOOK_ENCRYPTION_KEY";
const PREVIOUS_KEY_ENV = "CONVEX_WEARABLES_WEBHOOK_PREVIOUS_ENCRYPTION_KEY";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8_192;
const ALLOWED_PORTS = new Set([443]);

function decodeMasterKey(encoded: string | undefined, name: string): Buffer {
  if (!encoded) throw new Error(`${KEY_ENV} is required when external webhooks are enabled`);
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) throw new Error(`${name} must be a base64-encoded 32-byte key`);
  return key;
}

function masterKey(): Buffer {
  return decodeMasterKey(process.env[KEY_ENV], KEY_ENV);
}

function decryptionKeys(): Buffer[] {
  const keys = [masterKey()];
  if (process.env[PREVIOUS_KEY_ENV]) {
    keys.push(decodeMasterKey(process.env[PREVIOUS_KEY_ENV], PREVIOUS_KEY_ENV));
  }
  return keys;
}

function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function decryptSecret(value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("Invalid encrypted webhook secret");
  for (const key of decryptionKeys()) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      // Try the bounded previous deployment key during an explicit rotation.
    }
  }
  throw new Error("Webhook secret cannot be decrypted with configured keys");
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && parts[2] === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function isBlockedIp(address: string): boolean {
  const unwrapped =
    address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const kind = isIP(unwrapped);
  if (kind === 4) return isBlockedIpv4(unwrapped);
  if (kind !== 6) return true;
  const normalized = unwrapped.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    /^fe[89ab][0-9a-f]:/.test(normalized) ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff")
  )
    return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isBlockedIpv4(mapped);
  if (normalized.startsWith("2001:db8:")) return true;
  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  return !Number.isFinite(first) || first < 0x2000 || first > 0x3fff;
}

async function validateAndResolve(
  rawUrl: string,
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  if (rawUrl.length > 2_048) throw new Error("Webhook URL is too long");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("Webhook URL must use HTTPS");
  if (url.username || url.password || url.hash)
    throw new Error("Webhook URL cannot contain credentials or a fragment");
  const hostname = url.hostname
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local"))
    throw new Error("Local webhook hosts are not allowed");
  const port = url.port ? Number(url.port) : 443;
  if (!ALLOWED_PORTS.has(port)) throw new Error("Webhook URL port is not allowed");
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isBlockedIp(record.address)))
    throw new Error("Webhook URL resolves to a prohibited address");
  const first = records[0];
  if (!first) throw new Error("Webhook URL did not resolve");
  return { url, address: first.address, family: first.family as 4 | 6 };
}

function signature(secret: string, id: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`, "utf8").digest("base64");
}

type SendResult = { status: number; abort: boolean; retryAfterMs?: number };

async function pinnedPost(args: {
  url: string;
  address: string;
  family: 4 | 6;
  body: string;
  headers: Record<string, string>;
}): Promise<SendResult> {
  const url = new URL(args.url);
  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  return await new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        servername: isIP(hostname) ? undefined : hostname,
        headers: {
          ...args.headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(args.body).toString(),
          "user-agent": "convex-wearables-webhooks/1",
        },
        lookup: (_hostname, _options, callback) => callback(null, args.address, args.family),
      },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) req.destroy(new Error("Webhook response exceeded limit"));
        });
        response.on("end", () => {
          const retryAfter = response.headers["retry-after"];
          let retryAfterMs: number | undefined;
          if (typeof retryAfter === "string") {
            const seconds = Number(retryAfter);
            if (Number.isFinite(seconds) && seconds >= 0)
              retryAfterMs = Math.min(seconds * 1_000, 10 * 60 * 60_000);
            else {
              const retryAt = Date.parse(retryAfter);
              if (Number.isFinite(retryAt))
                retryAfterMs = Math.min(Math.max(retryAt - Date.now(), 0), 10 * 60 * 60_000);
            }
          }
          resolve({
            status: response.statusCode ?? 0,
            abort: response.headers["webhook-delivery"] === "abort-message",
            retryAfterMs,
          });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Webhook request timed out")));
    req.on("error", reject);
    req.end(args.body);
  });
}

type HostCtx = GenericActionCtx<GenericDataModel>;
type BridgeOperation =
  | "prepareEndpoint"
  | "getEndpoint"
  | "patchEndpointUrl"
  | "replaceEndpointSecret"
  | "rewrapEndpointSecrets"
  | "activateEndpoint"
  | "renewDeliveryLease"
  | "getDeliveryBundle";

async function bridge(
  ctx: HostCtx,
  component: ComponentApi,
  operation: BridgeOperation,
  payload: unknown,
) {
  return await ctx.runAction(component.outgoingWebhookBridge.execute, { operation, payload });
}

/** Run this handler from an internal `"use node"` action in the host app. */
export async function runOutgoingWebhookHostRequest(
  ctx: HostCtx,
  component: ComponentApi,
  request: OutgoingWebhookHostRequest,
) {
  switch (request.kind) {
    case "runtimeStatus": {
      let encryptionKeyConfigured = false;
      try {
        masterKey();
        encryptionKeyConfigured = true;
      } catch {
        // The status check does not reveal the key or fail the app.
      }
      return {
        encryptionKeyConfigured,
        previousEncryptionKeyConfigured: Boolean(process.env[PREVIOUS_KEY_ENV]),
        nativePinnedDelivery: true,
      };
    }
    case "validateUrl": {
      const result = await validateAndResolve(request.url);
      return { hostname: result.url.hostname, address: result.address, family: result.family };
    }
    case "createEndpoint": {
      await validateAndResolve(request.url);
      const secret = `whsec_${randomBytes(32).toString("base64url")}`;
      const endpointId = await bridge(ctx, component, "prepareEndpoint", {
        tenantId: request.tenantId,
        scope: request.scope,
        userId: request.userId,
        url: request.url,
        description: request.description,
        eventTypes: request.eventTypes,
        payloadMode: request.payloadMode ?? "reference",
        encryptedSigningSecret: encryptSecret(secret),
      });
      return { endpointId, status: "pending_verification", signingSecret: secret };
    }
    case "updateEndpointUrl": {
      await validateAndResolve(request.url);
      const endpoint = await bridge(ctx, component, "getEndpoint", {
        endpointId: request.endpointId,
      });
      if (!endpoint || endpoint.tenantId !== request.tenantId)
        throw new Error("Webhook endpoint not found");
      await bridge(ctx, component, "patchEndpointUrl", {
        tenantId: request.tenantId,
        endpointId: request.endpointId,
        url: request.url,
      });
      return null;
    }
    case "rotateSecret": {
      const secret = `whsec_${randomBytes(32).toString("base64url")}`;
      await bridge(ctx, component, "replaceEndpointSecret", {
        tenantId: request.tenantId,
        endpointId: request.endpointId,
        overlapMs: request.overlapMs ?? 60 * 60_000,
        encryptedSigningSecret: encryptSecret(secret),
      });
      return { endpointId: request.endpointId, signingSecret: secret };
    }
    case "rewrapSecret": {
      const endpoint = await bridge(ctx, component, "getEndpoint", {
        endpointId: request.endpointId,
      });
      if (!endpoint || endpoint.tenantId !== request.tenantId)
        throw new Error("Webhook endpoint not found");
      const current = encryptSecret(decryptSecret(endpoint.encryptedSigningSecret));
      const previous = endpoint.previousEncryptedSigningSecret
        ? encryptSecret(decryptSecret(endpoint.previousEncryptedSigningSecret))
        : undefined;
      await bridge(ctx, component, "rewrapEndpointSecrets", {
        tenantId: request.tenantId,
        endpointId: request.endpointId,
        encryptedSigningSecret: current,
        previousEncryptedSigningSecret: previous,
      });
      return null;
    }
    case "verifyEndpoint": {
      const endpoint = await bridge(ctx, component, "getEndpoint", {
        endpointId: request.endpointId,
      });
      if (!endpoint || endpoint.tenantId !== request.tenantId)
        throw new Error("Webhook endpoint not found");
      const destination = await validateAndResolve(endpoint.url);
      const id = crypto.randomUUID();
      const timestamp = Math.floor(Date.now() / 1_000);
      const body = JSON.stringify({
        id,
        type: "endpoint.verification",
        version: 1,
        occurredAt: Date.now(),
        tenantId: request.tenantId,
        subject: { kind: "connection" },
        idempotencyKey: `verify:${id}`,
        data: { challenge: true },
      });
      const result = await pinnedPost({
        ...destination,
        url: destination.url.toString(),
        body,
        headers: {
          "wearables-id": id,
          "wearables-timestamp": String(timestamp),
          "wearables-signature": `v1,${signature(decryptSecret(endpoint.encryptedSigningSecret), id, timestamp, body)}`,
          "wearables-attempt": "1",
          "wearables-event-type": "endpoint.verification",
        },
      });
      if (result.status < 200 || result.status >= 300)
        throw new Error(`Endpoint verification failed with HTTP ${result.status}`);
      await bridge(ctx, component, "activateEndpoint", { endpointId: request.endpointId });
      return { verified: true, status: result.status };
    }
    case "deliver": {
      const startedAt = Date.now();
      try {
        const renewed = await bridge(ctx, component, "renewDeliveryLease", {
          deliveryId: request.deliveryId,
          leaseToken: request.leaseToken,
        });
        if (!renewed)
          return {
            startedAt,
            durationMs: Date.now() - startedAt,
            success: false,
            permanent: true,
            errorCode: "lease_superseded",
          };
        const bundle = await bridge(ctx, component, "getDeliveryBundle", {
          deliveryId: request.deliveryId,
          leaseToken: request.leaseToken,
        });
        if (
          !bundle?.delivery ||
          !bundle.event ||
          !bundle.endpoint ||
          !bundle.config.externalDeliveryEnabled
        )
          return {
            startedAt,
            durationMs: Date.now() - startedAt,
            success: false,
            permanent: true,
            errorCode: "delivery_disabled",
          };
        const destination = await validateAndResolve(bundle.endpoint.url);
        const timestamp = Math.floor(Date.now() / 1_000);
        const secret = decryptSecret(bundle.endpoint.encryptedSigningSecret);
        const body = bundle.delivery.payloadJson ?? bundle.event.payloadJson;
        const signatures = [`v1,${signature(secret, bundle.event.eventPublicId, timestamp, body)}`];
        if (
          bundle.endpoint.previousEncryptedSigningSecret &&
          (bundle.endpoint.previousSecretValidUntil ?? 0) > Date.now()
        )
          signatures.push(
            `v1,${signature(decryptSecret(bundle.endpoint.previousEncryptedSigningSecret), bundle.event.eventPublicId, timestamp, body)}`,
          );
        const result = await pinnedPost({
          ...destination,
          url: destination.url.toString(),
          body,
          headers: {
            "wearables-id": bundle.event.eventPublicId,
            "wearables-timestamp": String(timestamp),
            "wearables-signature": signatures.join(" "),
            "wearables-attempt": String(bundle.delivery.attemptCount + 1),
            "wearables-event-type": bundle.event.eventType,
          },
        });
        const success = result.status >= 200 && result.status < 300;
        const permanent = result.abort || result.status === 410;
        return {
          startedAt,
          durationMs: Date.now() - startedAt,
          success,
          permanent,
          responseStatus: result.status,
          errorCode: success
            ? undefined
            : permanent
              ? result.abort
                ? "receiver_aborted"
                : "receiver_gone"
              : `http_${result.status}`,
          retryAfterMs: [429, 503].includes(result.status) ? result.retryAfterMs : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const permanent =
          message.includes("prohibited") ||
          message.includes("must use HTTPS") ||
          message.includes("not allowed") ||
          message.includes(KEY_ENV);
        return {
          startedAt,
          durationMs: Date.now() - startedAt,
          success: false,
          permanent,
          errorCode: permanent
            ? "unsafe_or_misconfigured_endpoint"
            : message.includes("timed out")
              ? "timeout"
              : "network_error",
        };
      }
    }
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

export function encryptWebhookSecretForTest(secret: string): string {
  return encryptSecret(secret);
}

export async function validateWebhookUrlForTest(url: string) {
  return await validateAndResolve(url);
}

export function decryptWebhookSecretForTest(secret: string): string {
  return decryptSecret(secret);
}

export function createOutgoingWebhookSignatureForTest(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): string {
  return signature(secret, id, timestamp, body);
}
