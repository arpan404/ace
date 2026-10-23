import type { Item, Run } from "@ace/protocol";
import { formatElapsed } from "./time.ts";

/*
 * How long a thought took, for its folded header. Items carry when they began, not when they
 * finished, so a thought ends where what followed it began (the next item, else its turn's end).
 * Pure over the thread's order.
 */

interface Reader {
  readonly order: readonly string[];
  item(id: string): Item | undefined;
  run(id: string): Run | undefined;
}

/** How long thought `itemId` took, in ms; undefined while it goes on or when unknown. */
export function thoughtMs(reader: Reader, itemId: string): number | undefined {
  const at = reader.order.lastIndexOf(itemId);
  const item = at < 0 ? undefined : reader.item(itemId);
  if (item?.type !== "reasoning" || !item.complete) return undefined;
  const next = reader.order[at + 1];
  const ended =
    next === undefined
      ? item.runId === undefined
        ? undefined
        : reader.run(item.runId)?.endedAt
      : reader.item(next)?.createdAt;
  return ended === undefined || ended < item.createdAt ? undefined : ended - item.createdAt;
}

/** A thought's header: still going, how long it took, or just that it happened. */
export function thoughtLabel(complete: boolean, tookMs: number | undefined): string {
  if (!complete) return "Thinking…";
  if (tookMs === undefined) return "Thought";
  return tookMs >= 1000 ? `Thought for ${formatElapsed(tookMs)}` : "Thought for a moment";
}
