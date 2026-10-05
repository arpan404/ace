import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { useCallback, useMemo } from "react";

/**
 * Whether an item is still streaming: incomplete, and its run still going. Ending a run (Stop,
 * a failure) leaves its partial text incomplete, but nothing more will arrive.
 */
export function useStreaming(threadId: string, item: Item | undefined): boolean {
  const incomplete = !!item && !item.complete;
  const runId = incomplete ? item.runId : undefined;
  const keys = useMemo(() => (runId ? ([`run:${runId}`] as const) : ([] as const)), [runId]);
  const read = useCallback(
    (reader: ThreadReader) => (runId ? reader.run(runId)?.state !== "active" : false),
    [runId],
  );
  const ended = useThread(threadId, keys, read) ?? false;
  return incomplete && !ended;
}
