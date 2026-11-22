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
/**
 * A tool call's state as one update carries it: its call, phase and the whole of every field,
 * with whether the SDK marked a field shortened. A start and every partial differ, and two
 * partials alike in all but their last character differ too. SDK 1.0.35 stores the message it
 * maps the update itself to, `truncated` included, so a shortened stored copy is identical to
 * the update it came from: it matches that one update, and only by equality.
 */
const toolIdentity = (
  callId: string,
  phase: string,
  args: unknown,
  result: unknown,
  truncated: unknown,
) => {
  const cut = object(truncated);
  return digest(
    `tool_call\0${callId}\0${phase}\0${JSON.stringify(args ?? null)}\0${JSON.stringify(result ?? null)}\0${cut.args === true ? 1 : 0}${cut.result === true ? 1 : 0}`,
  );
};
/** Whether stored event `stored` is the one update `framed` became. */
export function sameUpdate(stored: string, framed: string): boolean {
  return stored === framed;
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
      return toolIdentity(string(body.callId) ?? "", phase, call.args, call.result, call.truncated);
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
      return toolIdentity(
        string(body.call_id) ?? "",
        phase,
        body.args,
        body.result,
        body.truncated,
      );
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
