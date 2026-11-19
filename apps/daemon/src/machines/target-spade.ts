import { createHash, createHmac } from "node:crypto";
import {
  maxSpadeResponseBytes,
  type Device,
  type MachineCallOrigin,
  type MachineSpadeResult,
  type SpadeInboxRequest,
} from "@ace/protocol";
import { spadeRequest, type SpadeConnection } from "../spade/forward.ts";
import type { Risk } from "./grant-rules.ts";
import { TargetRefusal } from "./target-refusal.ts";

/** Characters of the calling machine's name the inbox is told. */
export const maxStampedName = 100;

/** How long this machine's Spade has to answer: an `answer` long poll waits up to 25 s. */
const inboxTimeoutMs = 30_000;

/**
 * Whether an inbox request only reads (ADR 0132): listing bots and reading an answer read; an
 * ask, a stop or anything this build doesn't know acts.
 */
export function inboxRisk(request: SpadeInboxRequest): Risk {
  return request.op === "bots" || request.op === "answer" ? "read" : "operate";
}

/**
 * The signature Spade checks on an inbox request (docs/teams.md): HMAC-SHA256, keyed with this
 * daemon's local token, of `ace-spade-inbox/1`, the time, the sender, its name and the body's
 * SHA-256, one per line. Only the daemon (and whoever already holds its token) can make one, so
 * Spade's own bearer token never reaches the inbox alone.
 */
export function inboxProof(
  key: string,
  time: number,
  sender: string,
  name: string,
  body: Buffer,
): string {
  const digest = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", key)
    .update(`ace-spade-inbox/1\n${time}\n${sender}\n${name}\n${digest}`)
    .digest("hex");
}

/**
 * The calling machine as Spade's inbox reads it; only ace sets these, never the caller. The
 * sender is the pairing that authenticated the call here, not the host id the caller claims, so
 * one linked machine can't read or stop another's asks. The name is percent-encoded UTF-8.
 */
export function inboxStamps(
  device: Device,
  origin: MachineCallOrigin,
  body: Buffer,
  key: string,
  time: number,
): Record<string, string> {
  // Cut first, by characters: 100 of them stay within Spade's 1 KiB header cap once encoded.
  const name = encodeURIComponent(Array.from(origin.hostName).slice(0, maxStampedName).join(""));
  return {
    "x-ace-from-host": device.id,
    "x-ace-from-name": name,
    "x-ace-inbox-time": String(time),
    "x-ace-inbox-proof": inboxProof(key, time, device.id, name, body),
  };
}

/**
 * A `spade` machine call, forwarded to this machine's Spade as `POST /v1/inbox` with Spade's
 * token and the calling machine stamped. The body passes through unread; Spade's JSON answer
 * comes back with its status. Spade off or unreachable here refuses `unavailable`.
 */
export async function forwardToInbox(
  connection: SpadeConnection | undefined,
  key: string | undefined,
  device: Device,
  origin: MachineCallOrigin,
  request: SpadeInboxRequest,
  signal: AbortSignal,
  now: number,
): Promise<MachineSpadeResult> {
  // A pairing made from a time-limited link is a guest, not one of the person's machines.
  if (device.expiresAt !== null && device.expiresAt !== undefined)
    throw new TargetRefusal(
      "machine_forbidden",
      "Only the person's own linked machines can reach Spade here.",
    );
  if (!connection) throw new TargetRefusal("unavailable", "Spade isn't running on this machine.");
  if (!key) throw new TargetRefusal("unavailable", "This machine's ace isn't ready for Spade.");
  const sent = Buffer.from(JSON.stringify(request));
  const answer = await spadeRequest(
    connection,
    {
      method: "POST",
      path: "/v1/inbox",
      body: sent,
      contentType: "application/json",
      headers: inboxStamps(device, origin, sent, key, now),
    },
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(inboxTimeoutMs)]),
      maxBytes: maxSpadeResponseBytes,
    },
  ).catch(() => undefined);
  if (!answer) throw new TargetRefusal("unavailable", "Spade on this machine didn't answer.");
  if (answer.kind === "too_large")
    throw new TargetRefusal("unavailable", "Spade's answer here is too large to send back.");
  const text = answer.body.toString("utf8");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new TargetRefusal(
      "unavailable",
      "Spade on this machine answered with something unreadable.",
    );
  }
  return { status: answer.status, body };
}
