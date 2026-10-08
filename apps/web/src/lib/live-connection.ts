import { useConnectionState } from "@ace/client-react";

/** Connection freshness is shared by every thread indicator, including the phone header. */
export function useLiveConnection() {
  const state = useConnectionState();
  const fresh = state === "ready";
  const staleLabel = fresh
    ? undefined
    : state === "offline"
      ? "Offline"
      : state === "fatal"
        ? "Disconnected"
        : "Reconnecting…";
  return { fresh, staleLabel };
}
