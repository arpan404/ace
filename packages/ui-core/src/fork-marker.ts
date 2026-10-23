import type { Item } from "@ace/protocol";
import { blockItems, type Block } from "./transcript-blocks.ts";

/*
 * Where a fork's transcript turns from the conversation it continues to its own: one
 * "Forked from <source>" divider. The history before it is the source's, copied by ace when
 * the fork was made (`inherited`) or brought along by the provider's own fork; the fork's own
 * work starts at the first message ace delivered to it. Pure.
 */

export interface ForkFacts {
  /** The thread it was forked from. */
  sourceThreadId: string;
  /** The transcript's items, oldest first, from the thread's first item. */
  order: readonly string[];
  item(id: string): Item | undefined;
}

/** The fork's first item of its own: the first message ace delivered that it didn't copy. */
function ownStart(facts: ForkFacts): string | undefined {
  return facts.order.find((id) => {
    const item = facts.item(id);
    return item?.type === "message" && item.inherited === undefined && item.origin !== undefined;
  });
}

/**
 * `blocks` with the fork's divider before the first block showing anything from its first item
 * of its own on, or after everything while it has none yet (it waits for its first message).
 */
export function withForkMarker(blocks: readonly Block[], facts: ForkFacts): Block[] {
  const marker: Block = { kind: "forked", key: "forked", threadId: facts.sourceThreadId };
  const start = ownStart(facts);
  const from = start === undefined ? -1 : facts.order.indexOf(start);
  const position = new Map(facts.order.map((id, index) => [id, index]));
  const at =
    from < 0
      ? -1
      : blocks.findIndex((block) =>
          blockItems(block).some((id) => (position.get(id) ?? -1) >= from),
        );
  return at < 0 ? [...blocks, marker] : [...blocks.slice(0, at), marker, ...blocks.slice(at)];
}
