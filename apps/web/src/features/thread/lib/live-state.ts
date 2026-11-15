import { useLiveList, useThreadFreshness } from "@/lib/live-connection.ts";
import { threadIsRunning } from "@ace/ui-core";
import { useThreadMeta } from "@ace/client-react";

/**
 * A thread's live state as its surfaces may show it (`useThreadFreshness`): cached agent facts
 * remain visible during reconnect, but cannot claim live work; nor can a copy the daemon hasn't
 * confirmed yet (read back from disk). While it isn't `fresh`, show `staleLabel` instead of live
 * status and hold actions on what is shown.
 */
/**
 * A subagent's state as its rows show it: rolled up from the parent thread's copy and, for a
 * delegated child, the child's own list row, so it is current only while both are.
 */
export function useSubagentsFresh(threadId: string): boolean {
  const thread = useThreadFreshness(threadId).fresh;
  const list = useLiveList();
  return thread && list;
}

export function useThreadLiveState(threadId: string) {
  const { fresh, staleLabel, isFresh, live } = useThreadFreshness(threadId);
  const status = useThreadMeta(threadId)?.status;
  return {
    fresh,
    paused: status?.state === "limited",
    canStop: fresh && threadIsRunning(status),
    staleLabel,
    isFresh,
    live,
  };
}
