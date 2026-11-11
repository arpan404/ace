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
  | { kind: "ask"; key: string; callId: string; name: string; sentence: string };

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
    if (entry.kind !== "reply") continue;
    const words = entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []));
    if (entry.live) words.push(entry.live);
    const text = words.join("\n\n").trim();
    const end = entry.end && entry.end.kind !== "finished" ? entry.end.kind : undefined;
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
      sentence: approval.sentence,
    });
  return bubbles;
}
