import {
  maxSpadeResponseBytes,
  type MachineCallOrigin,
  type MachineSpadeResult,
  type SpadeInboxRequest,
} from "@ace/protocol";
import { spadeRequest, type SpadeConnection } from "../spade/forward.ts";
import type { Risk } from "./grant-rules.ts";
import { TargetRefusal } from "./target-refusal.ts";

/** How long this machine's Spade has to answer: an `answer` long poll waits up to 25 s. */
const inboxTimeoutMs = 30_000;

/**
 * Whether an inbox request only reads (ADR 0132): listing bots and reading an answer read; an
 * ask, a stop or anything this build doesn't know acts.
 */
export function inboxRisk(request: SpadeInboxRequest): Risk {
  return request.op === "bots" || request.op === "answer" ? "read" : "operate";
}

/** The calling machine as Spade's inbox reads it; only ace sets these, never the caller. */
export function inboxStamps(origin: MachineCallOrigin): Record<string, string> {
  return { "x-ace-from-host": origin.hostId, "x-ace-from-name": origin.hostName };
}

/**
 * A `spade` machine call, forwarded to this machine's Spade as `POST /v1/inbox` with Spade's
 * token and the calling machine stamped. The body passes through unread; Spade's JSON answer
 * comes back with its status. Spade off or unreachable here refuses `unavailable`.
 */
export async function forwardToInbox(
  connection: SpadeConnection | undefined,
  origin: MachineCallOrigin,
  request: SpadeInboxRequest,
  signal: AbortSignal,
): Promise<MachineSpadeResult> {
  if (!connection) throw new TargetRefusal("unavailable", "Spade isn't running on this machine.");
  const answer = await spadeRequest(
    connection,
    {
      method: "POST",
      path: "/v1/inbox",
      body: Buffer.from(JSON.stringify(request)),
      contentType: "application/json",
      headers: inboxStamps(origin),
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
