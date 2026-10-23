import type { Fact } from "@ace/core";
import { inheritedMessages } from "@ace/handoff";
import type { AgentId, Item, ThreadId } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/** The newest messages a fork copies; older ones are a link away, in the source. */
const maxMessages = 400;
/** Bounds the cold read: at most this many pages of 200 items, newest first. */
const maxPages = 40;
const pageBytes = 1024 * 1024;
/** A copied message keeps at most this much of its text (UTF-16 bytes). */
const maxTextBytes = 256 * 1024;

/** A preview's text, read whole from its stream as the source held it at the fork point. */
function wholeText(repo: EngineRepository, source: ThreadId, through: number, item: Item): Item {
  if (item.type !== "message") return item;
  const parts = item.parts.map((part) => {
    if (part.type !== "text" || !part.source || part.source.bytes <= part.text.length * 2)
      return part;
    const read = repo.store.readHistoricalStream(
      source,
      part.source.streamId,
      through,
      0,
      Math.min(part.source.bytes, maxTextBytes),
    );
    return { type: "text" as const, text: read.bytes.toString("utf16le") };
  });
  return { ...item, parts };
}

/** The forked agent's messages up to the fork point, oldest first, newest `maxMessages` kept. */
function sourceMessages(
  repo: EngineRepository,
  source: ThreadId,
  through: number,
  agentId: AgentId,
): Item[] {
  const pages: Item[][] = [];
  let kept = 0;
  let before: number | null = through + 1;
  for (let page = 0; before !== null && page < maxPages && kept < maxMessages; page++) {
    const read = repo.store.readBoundedHistoricalItemPage(source, through, before, 200, pageBytes);
    const messages = read.items.filter(
      (item) => item.type === "message" && item.agentId === agentId,
    );
    pages.unshift(messages);
    kept += messages.length;
    before = read.itemsBefore;
  }
  return pages
    .flat()
    .slice(-maxMessages)
    .map((item) => wholeText(repo, source, through, item));
}

/**
 * The facts that open a fork on the conversation it continues: copies of the source agent's
 * asks and answers through the fork point, each marked with where it came from. A cold
 * operation, bounded by `maxPages` and `maxMessages`, run once when the fork is made.
 */
export function forkHistoryFacts(
  repo: EngineRepository,
  source: ThreadId,
  point: { throughSeq: number; parentAgentId: AgentId },
): Fact[] {
  const items = sourceMessages(repo, source, point.throughSeq, point.parentAgentId);
  return inheritedMessages(items, point.parentAgentId).map((message) => ({
    type: "item.upsert",
    agent: "root",
    item: `inherited:${message.itemId}`,
    draft: {
      type: "message",
      role: message.role,
      parts: message.parts,
      complete: true,
      synthetic: false,
      inherited: { threadId: source, itemId: message.itemId },
      ...(message.executionSource ? { executionSource: message.executionSource } : {}),
    },
  }));
}
