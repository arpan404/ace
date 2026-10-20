import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { useThreadLiveState } from "../lib/live-state.ts";
import type { Item } from "@ace/protocol";
import { useCallback, useMemo } from "react";

/**
 * Whether an incomplete item's run is over. The daemon closes open text when its turn ends, but
 * items stored before it did stay incomplete; nothing more will arrive into them.
 */
export function useRunEnded(threadId: string, item: Item | undefined): boolean {
  const runId = item && !item.complete ? item.runId : undefined;
  const keys = useMemo(() => (runId ? ([`run:${runId}`] as const) : ([] as const)), [runId]);
  const read = useCallback(
    (reader: ThreadReader) => (runId ? reader.run(runId)?.state !== "active" : false),
    [runId],
  );
  return useThread(threadId, keys, read) ?? false;
}

/** Whether an item is still streaming: incomplete, and its run still going. */
export function useStreaming(threadId: string, item: Item | undefined): boolean {
  const live = useThreadLiveState(threadId);
  const ended = useRunEnded(threadId, item);
  return !!item && !item.complete && !ended && live.fresh && !live.paused;
}
