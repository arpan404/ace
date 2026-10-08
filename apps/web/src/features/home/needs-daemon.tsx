import { useConnectionState } from "@ace/client-react";
import type { ReactElement } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";

/**
 * Whether actions built on one-shot daemon requests (browsing folders to add a project) can
 * run. Those are never saved for a reconnect, so offline they are off rather than failing
 * (UX audit SY-6); durable commands keep working and wait.
 */
export function useDaemonReachable(): boolean {
  const state = useConnectionState();
  return state !== "offline" && state !== "fatal";
}

/** Says why `children` is off while the daemon can't be reached; otherwise just `children`. */
export function NeedsDaemon(props: { reachable: boolean; children: ReactElement }) {
  return props.reachable ? props.children : <Tip label="Needs ace">{props.children}</Tip>;
}
