import { useMemo } from "react";
import { blockItems, type Block } from "./blocks.ts";
import { useLastSeen } from "./seen.ts";

/**
 * Key of the first block that arrived since the reader last read this thread, by the daemon's
 * read cursor (`useLastSeen`, SY-13), or undefined. The divider stays where it was placed for
 * the whole visit (`order` may be a jumped window of older items).
 */
export function useNewActivity(
  threadId: string,
  blocks: readonly Block[],
  order: readonly string[],
  _liveNewest?: string | undefined,
): string | undefined {
  const seen = useLastSeen(threadId);
  return useMemo(() => {
    if (seen === undefined) return undefined;
    const at = order.indexOf(seen);
    if (at < 0 || at === order.length - 1) return undefined;
    const position = new Map(order.map((id, index) => [id, index]));
    return blocks.find((block) => blockItems(block).some((id) => (position.get(id) ?? -1) > at))
      ?.key;
  }, [seen, order, blocks]);
}
