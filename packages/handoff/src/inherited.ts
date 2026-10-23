import type { ContentPart, ExecutionSource, Item, ItemId } from "@ace/protocol";
import { withoutHandoffEnvelope } from "./envelope.ts";
import { personMessage } from "./select.ts";

/*
 * What a fork copies of the thread it came from, so its transcript opens on the conversation it
 * continues: the forked agent's own asks and answers, oldest first. Pure.
 */

export interface InheritedMessage {
  /** The source item it copies. */
  itemId: ItemId;
  role: "user" | "assistant";
  parts: ContentPart[];
  executionSource?: ExecutionSource | undefined;
}

/**
 * Text and mentions only: files and images name the source thread's own attachments, and a
 * text part's stream belongs to the source item.
 */
function copiedParts(item: Extract<Item, { type: "message" }>): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const [index, part] of item.parts.entries()) {
    if (part.type === "mention") parts.push(part);
    if (part.type !== "text") continue;
    // A message sent right after a handoff still carries ace's block in front of the words.
    const text = index === 0 ? (withoutHandoffEnvelope(part.text) ?? part.text) : part.text;
    if (text.trim()) parts.push({ type: "text", text });
  }
  return parts;
}

/**
 * The messages a fork of `agentId`'s conversation starts with, from `items` in conversation
 * order: what the person asked and what the agent answered. ace's own inputs (results,
 * restarts, handoffs), injected messages and anything still being written are left out, and so
 * is a message left with no words.
 */
export function inheritedMessages(items: Iterable<Item>, agentId: string): InheritedMessage[] {
  const copied: InheritedMessage[] = [];
  for (const item of items) {
    if (item.type !== "message" || item.agentId !== agentId || !item.complete) continue;
    if (item.role === "user" ? !personMessage(item) : item.synthetic) continue;
    const parts = copiedParts(item);
    if (!parts.some((part) => part.type === "text")) continue;
    copied.push({
      itemId: item.id,
      role: item.role,
      parts,
      ...(item.executionSource ? { executionSource: item.executionSource } : {}),
    });
  }
  return copied;
}
