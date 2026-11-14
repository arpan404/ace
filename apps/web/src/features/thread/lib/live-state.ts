import { useThreadFreshness } from "@/lib/live-connection.ts";
import { threadIsRunning } from "@ace/ui-core";
import { useThreadMeta } from "@ace/client-react";

/**
 * A thread's live state as its surfaces may show it (`useThreadFreshness`): cached agent facts
 * remain visible during reconnect, but cannot claim live work; nor can a copy the daemon hasn't
 * confirmed yet (read back from disk). While it isn't `fresh`, show `staleLabel` instead of live
 * status and hold actions on what is shown.
 */
export function useThreadLiveState(threadId: string) {
  const { fresh, staleLabel } = useThreadFreshness(threadId);
  const status = useThreadMeta(threadId)?.status;
  return {
    fresh,
    paused: status?.state === "limited",
    canStop: fresh && threadIsRunning(status),
    staleLabel,
  };
}
