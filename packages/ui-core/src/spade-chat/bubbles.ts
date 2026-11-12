import type { SpadeReplyEntry } from "./fold.ts";
import type { SpadeRememberedNote } from "./notes.ts";
import type { SpadeImageRef } from "./wire.ts";
import type { SpadeView } from "./view.ts";

/*
 * A conversation as a chat (ADR 0127): the person's messages and the bot's, nothing of how the
 * bot works. Tool calls, background jobs and compaction stay with the bot; an approval arrives
 * as a bubble of the bot's that the person answers, a question as the bot's bubble (ADR 0128),
 * and a note the bot saved as one quiet line between its bubbles.
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
  /** "Remembered: …": a note the bot saved or rewrote, which the person may open to edit. */
  | { kind: "remembered"; key: string; note: SpadeRememberedNote }
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

export function spadeBubbles(view: SpadeView): SpadeBubble[] {
  const bubbles: SpadeBubble[] = [];
  for (const entry of view.entries) {
    if (entry.kind === "user") {
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
    if (entry.kind === "reply") replyBubbles(entry, bubbles);
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

/**
 * A reply's bubbles: its words, split where it remembered a note or asked a question. The first
 * run keeps the reply's key, so a bubble keeps its place as the reply grows.
 */
function replyBubbles(entry: SpadeReplyEntry, bubbles: SpadeBubble[]) {
  let words: string[] = [];
  let runs = 0;
  const flush = () => {
    const text = words.join("\n\n").trim();
    words = [];
    if (!text) return;
    bubbles.push({
      kind: "bot",
      key: runs++ ? `${entry.key}:${runs}` : entry.key,
      text,
      live: false,
      end: undefined,
      error: undefined,
    });
  };
  for (const part of entry.parts) {
    if (part.kind === "text") words.push(part.text);
    else if (part.kind === "remembered") {
      flush();
      bubbles.push({ kind: "remembered", key: `${entry.key}:${part.key}`, note: part.note });
    } else if (part.kind === "question") {
      flush();
      words.push(part.text);
      flush();
    }
  }
  if (entry.live) words.push(entry.live);
  const text = words.join("\n\n").trim();
  const end = entry.end && entry.end.kind !== "finished" ? entry.end.kind : undefined;
  // A reply with nothing more to say yet shows only as the working line.
  if (!text && !end) return;
  bubbles.push({
    kind: "bot",
    key: runs ? `${entry.key}:${runs + 1}` : entry.key,
    text,
    live: entry.end === undefined,
    end,
    error: entry.end?.kind === "failed" ? entry.end.error : undefined,
  });
}
