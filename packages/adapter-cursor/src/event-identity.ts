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
    case "tool-call-started":
    case "partial-tool-call":
      return digest(`tool_call\0${string(body.callId) ?? ""}\0running`);
    case "tool-call-completed":
      return digest(`tool_call\0${string(body.callId) ?? ""}\0ended`);
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
    case "tool_call":
      return digest(
        `tool_call\0${string(body.call_id) ?? ""}\0${body.status === "running" ? "running" : "ended"}`,
      );
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
