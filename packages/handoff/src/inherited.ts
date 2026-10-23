import type { ContentPart, ExecutionSource, InheritedItem, Item, ThreadId } from "@ace/protocol";
import { withoutHandoffEnvelope } from "./envelope.ts";
import { personMessage } from "./select.ts";

/*
 * What a fork copies of the thread it came from, so its transcript opens on the conversation it
 * continues: the forked agent's own asks and answers, oldest first, as item drafts the daemon
 * (and the fake daemon) upsert into the fork. Pure.
 */

/** A copied message, or the note that older ones stayed behind, keyed for an idempotent upsert. */
export type InheritedDraft =
  | {
      key: string;
      draft: {
        type: "message";
        role: "user" | "assistant";
        parts: ContentPart[];
        complete: true;
        synthetic: false;
        inherited: InheritedItem;
        executionSource?: ExecutionSource;
      };
    }
  | {
      key: string;
      draft: { type: "notice"; level: "info"; code: "fork_history_trimmed"; text: string };
    };

/** Said after a text that was cut: the rest is in the source. */
export const trimmedText = "\n\n… The rest of this message is in the thread this was forked from.";
export const trimmedHistory = "Earlier messages are in the thread this was forked from.";

/**
 * Text and mentions only: files and images name the source thread's own attachments, and a
 * text part's stream belongs to the source item. A text whose stream holds more than it carries
 * was cut to the copy's budget and says so.
 */
function copiedParts(item: Extract<Item, { type: "message" }>): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const [index, part] of item.parts.entries()) {
    if (part.type === "mention") parts.push(part);
    if (part.type !== "text") continue;
    // A message sent right after a handoff still carries ace's block in front of the words.
    let text = index === 0 ? (withoutHandoffEnvelope(part.text) ?? part.text) : part.text;
    if (part.source && part.source.bytes > part.text.length * 2) text += trimmedText;
    if (text.trim()) parts.push({ type: "text", text });
  }
  return parts;
}

/**
 * The drafts a fork of `agentId`'s conversation in `source` starts with, from `items` in
 * conversation order: what the person asked and what the agent answered, each keeping when it
 * was said. ace's own inputs (results, restarts, handoffs), injected messages, anything still
 * being written and a message left with no words are left out. With `trimmed`, older messages
 * than these stayed in the source, and one note says so first.
 */
export function inheritedDrafts(
  items: Iterable<Item>,
  agentId: string,
  source: ThreadId,
  trimmed = false,
): InheritedDraft[] {
  const drafts: InheritedDraft[] = trimmed
    ? [
        {
          key: "inherited:trimmed",
          draft: {
            type: "notice",
            level: "info",
            code: "fork_history_trimmed",
            text: trimmedHistory,
          },
        },
      ]
    : [];
  for (const item of items) {
    if (item.type !== "message" || item.agentId !== agentId || !item.complete) continue;
    if (item.role === "user" ? !personMessage(item) : item.synthetic) continue;
    const parts = copiedParts(item);
    if (!parts.some((part) => part.type === "text")) continue;
    drafts.push({
      key: `inherited:${item.id}`,
      draft: {
        type: "message",
        role: item.role,
        parts,
        complete: true,
        synthetic: false,
        inherited: { threadId: source, itemId: item.id, at: item.createdAt },
        ...(item.executionSource ? { executionSource: item.executionSource } : {}),
      },
    });
  }
  return drafts;
}
