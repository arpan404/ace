import type { Item, ThreadListEntry } from "@ace/protocol";
import type { SubagentEntry } from "./subagent-group.ts";
import {
  delegatedState,
  rollupSubagent,
  subagentTerminal,
  type SubagentState,
} from "./subagents.ts";
import { settledResults, type DelegationResult } from "./system-events.ts";
import type { Block } from "./transcript-blocks.ts";

/*
 * Receipts of delegated work (`delegation.settled`) delivered one after another read as one
 * row: "4 subagents ran", not a stack of rows that each list a few children. Pure.
 */

type ItemBlock = Extract<Block, { kind: "item" }>;

/**
 * The blocks with each run of consecutive receipt rows merged into its first, the rest listed
 * in its `also`. Returns `blocks` itself when nothing merges.
 */
export function mergeReceipts(
  blocks: readonly Block[],
  item: (id: string) => Item | undefined,
): readonly Block[] {
  const isReceipt = (block: Block): block is ItemBlock =>
    block.kind === "item" && !!settledResults(item(block.itemId))?.length;
  const out: Block[] = [];
  let changed = false;
  for (const block of blocks) {
    const previous = out.at(-1);
    if (previous && isReceipt(previous) && isReceipt(block)) {
      out[out.length - 1] = {
        ...previous,
        also: [...(previous.also ?? []), block.itemId, ...(block.also ?? [])],
      };
      changed = true;
    } else out.push(block);
  }
  return changed ? out : blocks;
}

/** What a run of receipts delivered: each child's latest result, and when the last arrived. */
export function receiptResults(items: readonly (Item | undefined)[]): {
  results: DelegationResult[];
  deliveredAt: number | undefined;
} {
  const byThread = new Map<string, DelegationResult>();
  let deliveredAt: number | undefined;
  for (const item of items) {
    const results = settledResults(item);
    if (!item || !results?.length) continue;
    deliveredAt = Math.max(deliveredAt ?? item.createdAt, item.createdAt);
    for (const result of results) {
      byThread.delete(result.threadId);
      byThread.set(result.threadId, result);
    }
  }
  return { results: [...byThread.values()], deliveredAt };
}

const outcomes: Record<DelegationResult["outcome"], SubagentState> = {
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * A delivered child's row: what its launch knows (`launch`), filled in from the thread list
 * (`listed`) when its launch isn't loaded. It reads as its delivered outcome unless the child
 * has since taken new work, and it ran from its start to its own end, else to when its result
 * arrived. `lead` is the first line of what it found, or why it failed.
 */
export function receiptEntry(
  result: DelegationResult,
  launch: SubagentEntry | undefined,
  listed: ThreadListEntry | undefined,
  deliveredAt: number | undefined,
  lead: string,
): SubagentEntry {
  const listedState = listed ? delegatedState(listed.status) : undefined;
  const current =
    launch && listedState
      ? rollupSubagent(launch.state, listedState)
      : (launch?.state ?? listedState);
  // A revived child tree is live again, even though this delivery is in history.
  const state = current && !subagentTerminal(current) ? current : outcomes[result.outcome];
  const ended = subagentTerminal(state);
  return {
    ...launch,
    id: launch?.id ?? result.threadId,
    // The row opens the child's thread and keeps its delivered result in view, not its activity.
    agentId: undefined,
    childThreadId: result.threadId,
    provider: launch?.provider ?? listed?.provider,
    model: launch?.model ?? listed?.execution?.model,
    title: launch?.title ?? listed?.title ?? "Delegated thread",
    state,
    startedAt: launch?.startedAt || listed?.createdAt || 0,
    endedAt: ended ? (launch?.endedAt ?? deliveredAt) : undefined,
    result: lead || undefined,
  };
}
