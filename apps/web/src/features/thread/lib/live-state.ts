import { useLiveConnection } from "@/lib/live-connection.ts";
import { threadIsRunning } from "@ace/ui-core";
import { useThreadMeta, useThreadUnconfirmed } from "@ace/client-react";

/**
 * Cached agent facts remain visible during reconnect, but cannot claim live work; nor can a
 * copy the daemon hasn't confirmed yet (read back from disk).
 */
export function useThreadLiveState(threadId: string) {
  const connection = useLiveConnection();
  const status = useThreadMeta(threadId)?.status;
  const unconfirmed = useThreadUnconfirmed(threadId);
  const fresh = connection.fresh && !unconfirmed;
  const { staleLabel } = connection;
  const paused = status?.state === "limited";
  return {
    fresh,
    paused,
    canStop: fresh && threadIsRunning(status),
    staleLabel,
  };
}
