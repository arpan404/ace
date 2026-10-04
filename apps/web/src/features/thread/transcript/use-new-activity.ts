import { useEffect, useMemo, useRef, useState } from "react";
import { blockItems, type Block } from "./blocks.ts";
import { lastSeen, markSeen } from "./seen.ts";

/**
 * Key of the first block that arrived since the reader last had this thread open, or
 * undefined. The divider stays where it was placed for the whole visit; leaving the thread
 * records the live tail's newest item as seen (`order` may be a jumped window of older items).
 */
export function useNewActivity(
  threadId: string,
  blocks: readonly Block[],
  order: readonly string[],
  liveNewest: string | undefined,
): string | undefined {
  const [seen] = useState(() => lastSeen(threadId));
  const newest = useRef<string | undefined>(undefined);
  useEffect(() => {
    newest.current = liveNewest ?? newest.current;
  }, [liveNewest]);
  useEffect(() => {
    const record = () => {
      if (newest.current) markSeen(threadId, newest.current);
    };
    addEventListener("pagehide", record);
    return () => {
      removeEventListener("pagehide", record);
      record();
    };
  }, [threadId]);
  return useMemo(() => {
    if (seen === undefined) return undefined;
    const at = order.indexOf(seen);
    if (at < 0 || at === order.length - 1) return undefined;
    const position = new Map(order.map((id, index) => [id, index]));
    return blocks.find((block) => blockItems(block).some((id) => (position.get(id) ?? -1) > at))
      ?.key;
  }, [seen, order, blocks]);
}
