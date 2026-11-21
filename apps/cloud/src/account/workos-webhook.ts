import { WorkosEvent } from "./workos-orgs.ts";

/** How far a delivery's signed time may be from ours, either way, before it is refused. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
/** The largest delivery read; WorkOS's events are a few kilobytes. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/** `t=<ms>, v1=<hex>`: the time WorkOS signed at and its HMAC-SHA256, in any order. */
function signatureParts(header: string): { time: number; signatures: string[] } | undefined {
  let time: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d{1,16}$/.test(value)) time = Number(value);
    else if (key === "v1" && value && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  return time === undefined || signatures.length === 0 ? undefined : { time, signatures };
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks one WorkOS webhook delivery (ADR 0206 §6): the `WorkOS-Signature` header must carry a
 * `v1` HMAC-SHA256 of `<t>.<body>` under the endpoint's secret, and `t` must be within
 * {@link WEBHOOK_TOLERANCE_MS} of now, so a captured delivery can't be replayed later. Returns
 * the event it carries, decoded leniently, or undefined for anything unsigned, forged, stale or
 * unreadable.
 */
export async function verifiedWebhook(
  secret: string,
  header: string | null,
  body: string,
  now: number,
): Promise<WorkosEvent | undefined> {
  if (!header || header.length > 1024) return undefined;
  const parts = signatureParts(header);
  if (!parts || Math.abs(now - parts.time) > WEBHOOK_TOLERANCE_MS) return undefined;
  const expected = await hmacHex(secret, `${parts.time}.${body}`);
  if (!parts.signatures.some((signature) => sameHex(signature, expected))) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  const event = WorkosEvent.safeParse(raw);
  return event.success ? event.data : undefined;
}
