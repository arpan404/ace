import { useConnectionState } from "@ace/client-react";

/** Connection freshness is shared by every thread indicator, including the phone header. */
export function useLiveConnection() {
  const fresh = useConnectionState() === "ready";
  return { fresh, staleLabel: fresh ? undefined : "Connection lost · activity paused" };
}
