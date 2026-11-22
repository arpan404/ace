import { createHash } from "node:crypto";
import { object, string } from "./contracts.ts";

/*
 * The seam between ace's committed frames and the SDK's own stored run events (ADR 0043,
 * amendment of 2026-11-22). SDK 1.0.35 hands each update to onDelta and then stores the
 * message it maps that update to (or nothing, for shell-output, task, step and token updates).
 * A frame carries the sequence of the last event stored before it and, for an update that will
 * be stored, the identity of the event it becomes: recovery skips exactly what ace committed.
 * Identity is the same function of the update (live) and of its stored message (recovery).
 */

const digest = (key: string) => createHash("sha256").update(key).digest("hex");
/** How much of each field a shortened copy is trusted to keep, to tell its update apart. */
const kept = 256;
/**
 * A tool call's state as one update carries it, `exact:fingerprint`: exact by its phase and all
 * it holds, so a start and every partial differ; fingerprinted by its call, phase and the first
 * part of each field, which a copy the SDK shortened still shares with the update it came from.
 */
const fingerprint = (callId: string, phase: string, args: unknown, result: unknown) =>
  digest(
    `tool_call\0${callId}\0${phase}\0${JSON.stringify(args ?? null).slice(0, kept)}\0${JSON.stringify(result ?? null).slice(0, kept)}`,
  );
const toolIdentity = (callId: string, phase: string, args: unknown, result: unknown) =>
  `${digest(`tool_call\0${callId}\0${phase}\0${JSON.stringify(args ?? null)}\0${JSON.stringify(result ?? null)}`)}:${fingerprint(callId, phase, args, result)}`;
/** A stored copy the SDK shortened: only its fingerprint can match. */
const shortened = (callId: string, phase: string, args: unknown, result: unknown) =>
  `~:${fingerprint(callId, phase, args, result)}`;
/**
 * Whether stored event `stored` is the one update `framed` became: the same exact identity, or,
 * for a copy the SDK shortened, the same call, phase and leading content: a different update of
 * the same call (another partial) never matches it.
 */
export function sameUpdate(stored: string, framed: string): boolean {
  if (!stored.startsWith("~:")) return stored === framed;
  return framed.endsWith(stored.slice(1));
}

/** The identity of the event the SDK stores for this onDelta update; none when it stores none. */
export function updateIdentity(update: unknown): string | undefined {
  const body = object(update);
  switch (body.type) {
    case "text-delta":
      return digest(`assistant\0${string(body.text) ?? ""}`);
    case "thinking-delta":
      return digest(`thinking\0${string(body.text) ?? ""}`);
    case "thinking-completed":
      return digest("thinking\0");
    // Each update of a call is its own: a start, every partial and the end differ by content.
    case "tool-call-started":
    case "partial-tool-call":
    case "tool-call-completed": {
      const call = object(body.toolCall);
      const phase = body.type === "tool-call-completed" ? "ended" : "running";
      return toolIdentity(string(body.callId) ?? "", phase, call.args, call.result);
    }
    case "user-message-appended":
      return digest(`user\0${string(object(body.userMessage).text) ?? ""}`);
    case "summary":
      return digest(`task\0${string(body.summary) ?? ""}`);
    // Stored only when it reported usage; a wrong guess only means nothing is skipped.
    case "turn-ended":
      return digest("usage");
    default:
      return undefined;
  }
}

/** The identity of a stored SDK message, matching `updateIdentity` of the update it came from. */
export function storedIdentity(message: unknown): string | undefined {
  const body = object(message);
  switch (body.type) {
    case "assistant": {
      const content = object(body.message).content;
      const text = (Array.isArray(content) ? content : [])
        .map((part) => (object(part).type === "text" ? (string(object(part).text) ?? "") : ""))
        .join("");
      return digest(`assistant\0${text}`);
    }
    case "thinking":
      return digest(`thinking\0${string(body.text) ?? ""}`);
    case "tool_call": {
      const phase = body.status === "running" ? "running" : "ended";
      if (object(body.truncated).args === true || object(body.truncated).result === true)
        return shortened(string(body.call_id) ?? "", phase, body.args, body.result);
      return toolIdentity(string(body.call_id) ?? "", phase, body.args, body.result);
    }
    case "user": {
      const content = object(body.message).content;
      const first = Array.isArray(content) ? object(content[0]) : {};
      return digest(`user\0${string(first.text) ?? ""}`);
    }
    case "task":
      return digest(`task\0${string(body.text) ?? ""}`);
    case "usage":
      return digest("usage");
    default:
      return undefined;
  }
}
