/*
 * Webhook signing as Standard Webhooks specifies it (ADR 0173): HMAC-SHA256 over
 * `id.timestamp.body` with the secret's bytes, sent base64 as `v1,<signature>`. Pure apart from
 * the hash; the clock and randomness are passed in.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a request's timestamp may be from the daemon's clock, either way. */
export const webhookToleranceMs = 5 * 60_000;
const secretPrefix = "whsec_";
/** A delivery id: printable ASCII without spaces, as senders make them. */
const deliveryId = /^[\x21-\x7e]{1,256}$/;
const timestamp = /^\d{1,12}$/;
const maxSignatures = 16;

export type WebhookHeaders = { id: string; timestamp: number; signatures: string[] };
export type WebhookCheck = "ok" | "stale_timestamp" | "bad_signature";

/** The `webhook-*` headers of a request, or `bad_headers` when one is missing or malformed. */
export function readWebhookHeaders(
  headers: Headers,
): { ok: true; headers: WebhookHeaders } | { ok: false; error: "bad_headers" } {
  const id = headers.get("webhook-id");
  const time = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (id === null || !deliveryId.test(id)) return { ok: false, error: "bad_headers" };
  if (time === null || !timestamp.test(time)) return { ok: false, error: "bad_headers" };
  const signatures = (signature ?? "").split(" ").filter((entry) => entry !== "");
  if (signatures.length === 0 || signatures.length > maxSignatures)
    return { ok: false, error: "bad_headers" };
  return { ok: true, headers: { id, timestamp: Number(time), signatures } };
}

function key(secret: string): Buffer {
  return Buffer.from(
    secret.startsWith(secretPrefix) ? secret.slice(secretPrefix.length) : secret,
    "base64",
  );
}

function digest(secret: string, id: string, seconds: number, body: Uint8Array): Buffer {
  return createHmac("sha256", key(secret)).update(`${id}.${seconds}.`).update(body).digest();
}

/** The `webhook-signature` value a sender puts on `body` (also used by tests). */
export function signWebhook(secret: string, id: string, seconds: number, body: Uint8Array): string {
  return `v1,${digest(secret, id, seconds, body).toString("base64")}`;
}

/**
 * Whether a request is signed with `secret` and recent. The signatures are compared in constant
 * time; one matching `v1` entry is enough, so a sender can sign with an old and a new secret.
 */
export function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: Uint8Array,
  now: number,
): WebhookCheck {
  if (Math.abs(now - headers.timestamp * 1000) > webhookToleranceMs) return "stale_timestamp";
  const expected = digest(secret, headers.id, headers.timestamp, body);
  for (const entry of headers.signatures) {
    if (!entry.startsWith("v1,")) continue;
    const given = Buffer.from(entry.slice(3), "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return "ok";
  }
  return "bad_signature";
}

/** A new secret: `whsec_` and 32 random bytes in base64. */
export function newWebhookSecret(random: (size: number) => Uint8Array): string {
  return `${secretPrefix}${Buffer.from(random(32)).toString("base64")}`;
}
