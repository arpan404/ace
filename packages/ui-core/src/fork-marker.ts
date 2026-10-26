import type { Item } from "@ace/protocol";
import { blockItems, type Block } from "./transcript-blocks.ts";

/*
 * Where a fork's transcript turns from the conversation it continues to its own: one
 * "Forked from <source>" divider. The history before it is the source's, copied by ace when
 * the fork was made (`inherited`) or brought along by the provider's own fork; the fork's own
 * work starts at the first message ace delivered to it. Pure.
 */

/** When a message was said: a fork's copy keeps its time in the source, not the copy's. */
export function saidAt(item: Item): number {
  return item.inherited?.at ?? item.createdAt;
}

export interface ForkFacts {
  /** The thread it was forked from. */
  sourceThreadId: string;
  /** The loaded items, oldest first. */
  order: readonly string[];
  /** Whether `order` starts at the thread's first item. */
  fromStart: boolean;
  item(id: string): Item | undefined;
}

const inherited = (item: Item | undefined) => !!item?.inherited;

/**
 * Where the fork's own work starts in `order`: the first message ace delivered that is not the
 * source's, and whether the loaded items show the boundary (they start at the thread's start or
 * hold some of the source's history before it). Reads the prefix up to it and nothing after.
 */
function ownStart(facts: ForkFacts): { at: number; shown: boolean } {
  let before = facts.fromStart;
  for (const [at, id] of facts.order.entries()) {
    const item = facts.item(id);
    if (inherited(item)) before = true;
    else if (item?.type === "message" && item.origin !== undefined) return { at, shown: before };
  }
  return { at: -1, shown: before };
}

/**
 * `blocks` with the fork's divider before the first block showing anything from its own first
 * message on, or after everything while it has none yet (it waits for its first message). When
 * the loaded items reach neither the thread's start nor any of the source's history, the
 * boundary is further back and nothing is added. The source's messages only ever precede the
 * fork's own, so a boundary in view is final.
 */
export function withForkMarker(blocks: readonly Block[], facts: ForkFacts): readonly Block[] {
  const start = ownStart(facts);
  if (!start.shown) return blocks;
  const marker: Block = { kind: "forked", key: "forked", threadId: facts.sourceThreadId };
  const at = start.at < 0 ? -1 : blockFrom(blocks, facts.order, start.at);
  return at < 0 ? [...blocks, marker] : [...blocks.slice(0, at), marker, ...blocks.slice(at)];
}

/**
 * The block showing `order[from]`, or, when that item has no block of its own (a message still
 * waiting in the queue), the one showing the next item that has.
 */
function blockFrom(blocks: readonly Block[], order: readonly string[], from: number): number {
  for (let index = from; index < order.length; index++) {
    const id = order[index];
    const at = blocks.findIndex((block) => id !== undefined && blockItems(block).includes(id));
    if (at >= 0) return at;
  }
  return -1;
}
