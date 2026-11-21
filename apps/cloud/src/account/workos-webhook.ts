import { WorkosEvent } from "./workos-orgs.ts";

/** How far a delivery's signed time may be from ours, either way, before it is refused. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
/** The largest delivery read; WorkOS's events are a few kilobytes. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

const encoder = new TextEncoder();
/** Milliseconds since 1970, written as WorkOS writes them: no sign, no leading zero. */
const canonicalTime = /^[1-9][0-9]{0,15}$/;
const signatureHex = /^[0-9a-f]{64}$/;

/**
 * `t=<ms>, v1=<hex>[, v1=<hex>…]`: exactly one timestamp and at least one signature, every field
 * `name=value` with a single `=`, nothing else. Anything looser is refused rather than guessed.
 */
function signatureParts(header: string): { time: number; signatures: string[] } | undefined {
  let time: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const field = part.trim();
    const equals = field.indexOf("=");
    if (equals <= 0 || field.includes("=", equals + 1)) return undefined;
    const key = field.slice(0, equals);
    const value = field.slice(equals + 1);
    if (key === "t") {
      if (time !== undefined || !canonicalTime.test(value)) return undefined;
      time = Number(value);
    } else if (key === "v1") {
      if (!signatureHex.test(value)) return undefined;
      signatures.push(value);
    } else return undefined;
  }
  return time === undefined || signatures.length === 0 ? undefined : { time, signatures };
}

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

/**
 * Reads at most `max` bytes of a request's body, or undefined once it has more: a body past the
 * limit is never buffered whole, nor waited on to its end.
 */
export async function boundedBody(request: Request, max: number): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && !(/^[0-9]{1,12}$/.test(declared) && Number(declared) <= max))
    return undefined;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Checks one WorkOS webhook delivery (ADR 0206 §6, amendment 1): the `WorkOS-Signature` header
 * must carry one canonical `t` and a `v1` HMAC-SHA256 of `<t>.` followed by the body's bytes as
 * sent, under the endpoint's secret, checked by WebCrypto's own `verify`; `t` must be within
 * {@link WEBHOOK_TOLERANCE_MS} of now, so a captured delivery can't be replayed later. Only then
 * is the body decoded. Returns the event it carries, decoded leniently, or undefined for
 * anything unsigned, forged, stale or unreadable.
 */
export async function verifiedWebhook(
  secret: string,
  header: string | null,
  body: Uint8Array,
  now: number,
): Promise<WorkosEvent | undefined> {
  if (!header || header.length > 1024) return undefined;
  const parts = signatureParts(header);
  if (!parts || Math.abs(now - parts.time) > WEBHOOK_TOLERANCE_MS) return undefined;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const prefix = encoder.encode(`${parts.time}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);
  let verified = false;
  for (const signature of parts.signatures)
    if (await crypto.subtle.verify("HMAC", key, fromHex(signature), signed)) verified = true;
  if (!verified) return undefined;
  let raw: unknown;
  try {
    // The decoder drops a leading byte-order mark: it was signed, but it isn't JSON.
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
  const event = WorkosEvent.safeParse(raw);
  return event.success ? event.data : undefined;
}
