import { useLiveConnection } from "@/lib/live-connection.ts";
import { useThreadMeta } from "@ace/client-react";

/** Cached agent facts remain visible during reconnect, but cannot claim live work. */
export function useThreadLiveState(threadId: string) {
  const connection = useLiveConnection();
  const status = useThreadMeta(threadId)?.status;
  const { fresh, staleLabel } = connection;
  const paused = status?.state === "limited";
  return {
    fresh,
    paused,
    canStop: fresh && !paused,
    staleLabel,
  };
}
