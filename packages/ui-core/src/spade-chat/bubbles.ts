import type { SpadeImageRef } from "./wire.ts";
import type { SpadeView } from "./view.ts";

/*
 * A conversation as a chat (ADR 0127): the person's messages and the bot's, nothing of how the
 * bot works. Tool calls, background jobs and compaction stay with the bot; an approval arrives
 * as a bubble of the bot's that the person answers.
 */
export type SpadeBubble =
  | {
      kind: "person";
      key: string;
      text: string;
      images: readonly SpadeImageRef[];
      /** Not stored by Spade yet. */
      sending: boolean;
    }
  /** One of the bot's routines fired: a small label, `Daily briefing · 9:00`. */
  | { kind: "routine"; key: string; name: string; label: string }
  /** A message another bot sent into this conversation, labelled with the name it had. */
  | { kind: "other"; key: string; agent: { id: string; name: string }; text: string }
  | {
      kind: "bot";
      key: string;
      text: string;
      /** Still being written. */
      live: boolean;
      /** How the reply ended when it didn't finish on its own. */
      end: "stopped" | "failed" | "interrupted" | undefined;
      error: string | undefined;
    }
  /** `name`: the tool it asks to use, for `spadeApprovalSentence` with the bot's name. */
  | {
      kind: "ask";
      key: string;
      callId: string;
      name: string;
      sentence: string;
      /** What the call would do, as the bot sent it: shown on request before the answer. */
      arguments: unknown;
    };

/** What a bot answers a heartbeat when nothing needs the person (`spade_core::routine::QUIET`). */
export const spadeQuiet = "[quiet]";

/** Whether a reply's text is the quiet answer (case and a trailing full stop ignored). */
export function isSpadeQuiet(text: string): boolean {
  return text.trim().replace(/\.+$/, "").trim().toLowerCase() === spadeQuiet;
}

export function spadeBubbles(view: SpadeView): SpadeBubble[] {
  const bubbles: SpadeBubble[] = [];
  // Since the last reply ended: whether anything arrived, and whether all of it was a heartbeat.
  // A quiet answer only to heartbeats shows as nothing, like the heartbeats themselves (ADR 0129;
  // `silent_replies` in spade-core); one that also answers anything else always shows.
  let inputs = false;
  let onlyBeats = true;
  for (const entry of view.entries) {
    if (entry.kind === "job") {
      inputs = true;
      onlyBeats = false;
    }
    if (entry.kind === "user") {
      inputs = true;
      onlyBeats &&= entry.fromRoutine?.heartbeat === true;
      if (entry.fromRoutine) {
        if (!entry.fromRoutine.heartbeat)
          bubbles.push({
            kind: "routine",
            key: entry.key,
            name: entry.fromRoutine.name,
            label: entry.fromRoutine.label,
          });
        continue;
      }
      bubbles.push(
        entry.fromAgent
          ? { kind: "other", key: entry.key, agent: entry.fromAgent, text: entry.text }
          : {
              kind: "person",
              key: entry.key,
              text: entry.text,
              images: entry.images,
              sending: entry.pending === true,
            },
      );
      continue;
    }
    if (entry.kind !== "reply") continue;
    const words = entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
    if (entry.live) words.push(entry.live);
    const text = words.join("\n\n").trim();
    const end = entry.end && entry.end.kind !== "finished" ? entry.end.kind : undefined;
    const quiet =
      inputs &&
      onlyBeats &&
      (entry.end === undefined
        ? spadeQuiet.startsWith(text.toLowerCase())
        : entry.end.kind === "finished" && isSpadeQuiet(text));
    if (entry.end !== undefined) {
      inputs = false;
      onlyBeats = true;
    }
    if (quiet) continue;
    // A reply with nothing to say yet shows only as the working line.
    if (!text && !end) continue;
    bubbles.push({
      kind: "bot",
      key: entry.key,
      text,
      live: entry.end === undefined,
      end,
      error: entry.end?.kind === "failed" ? entry.end.error : undefined,
    });
  }
  for (const approval of view.approvals)
    bubbles.push({
      kind: "ask",
      key: `ask:${approval.callId}`,
      callId: approval.callId,
      name: approval.name,
      arguments: approval.arguments,
      sentence: approval.sentence,
    });
  return bubbles;
}
