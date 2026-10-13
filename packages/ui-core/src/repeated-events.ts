import type { Item } from "@ace/protocol";

/*
 * The same event, one row: consecutive identical failures (a Stop pressed three times, an agent
 * retrying a refused tool) read as one row with ×N. Each row's count looks a bounded span either
 * way, never the whole thread. Pure.
 */

/** Work that can sit between two tries of the same thing without making them separate events. */
function between(item: Item): boolean {
  return (
    item.type === "tool_call" ||
    item.type === "reasoning" ||
    (item.type === "notice" && item.level !== "error")
  );
}

/**
 * How many identical events the row at `index` stands for: 0 when an earlier row already counts
 * it, otherwise itself and the identical ones that follow with only tool calls, reasoning or
 * quiet notices between. `keyOf` names an event; undefined means the item isn't one.
 */
export function repeatCount(
  order: readonly string[],
  index: number,
  item: (id: string) => Item | undefined,
  keyOf: (item: Item | undefined) => string | undefined,
  span = 32,
): number {
  const own = keyOf(item(order[index] ?? ""));
  if (own === undefined) return 1;
  const same = (at: number): boolean | undefined => {
    const other = item(order[at] ?? "");
    if (!other) return undefined;
    const key = keyOf(other);
    if (key !== undefined) return key === own;
    return between(other) ? undefined : false;
  };
  for (let at = index - 1; at >= Math.max(0, index - span); at--) {
    const match = same(at);
    if (match === true) return 0;
    if (match === false) break;
  }
  let count = 1;
  for (let at = index + 1; at < Math.min(order.length, index + 1 + span); at++) {
    const match = same(at);
    if (match === true) count++;
    else if (match === false) break;
  }
  return count;
}

/** An error notice as a repeatable failure: same agent, code, title and words. */
export function failureKey(item: Item | undefined): string | undefined {
  if (item?.type !== "notice" || item.level !== "error") return undefined;
  return [item.agentId, item.code ?? "", item.title ?? "", item.text.trim()].join("\u0000");
}

/** How many identical failures the error row at `index` stands for (see `repeatCount`). */
export function failureCount(
  order: readonly string[],
  index: number,
  item: (id: string) => Item | undefined,
  span = 32,
): number {
  return repeatCount(order, index, item, failureKey, span);
}
