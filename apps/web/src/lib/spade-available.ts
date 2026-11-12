import type { SpadeStatus } from "@ace/protocol";
import { useClient } from "@ace/client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDaemonQuery } from "./daemon-query.ts";

/**
 * Whether this window's machine shows Spade (ADR 0139). Every build carries Spade; the daemon
 * decides at run time from `features.json` in its home and says so in `spade.status` (`hidden`).
 * Hidden, the app keeps only Spade's mark in the rail, as coming soon, and leaves out its screens
 * and settings.
 */
export const spadeShown = (status: Pick<SpadeStatus, "hidden">): boolean => status.hidden !== true;

/** Kept between sessions (`query-persistence.ts`), so a reload shows the last answer at once. */
export const spadeShownKey = ["spade", "shown"] as const;

/**
 * The daemon's word on Spade: true shown, false hidden, undefined until it first answers. Live:
 * `spade.status.changed` follows edits to `features.json` without a reload.
 */
export function useSpadeShown(): boolean | undefined {
  const client = useClient();
  const cache = useQueryClient();
  const query = useDaemonQuery({
    queryKey: spadeShownKey,
    staleTime: Number.POSITIVE_INFINITY,
    read: async (daemon, signal) =>
      spadeShown((await daemon.request({ type: "spade.status" }, { signal })).status),
  });
  useEffect(() => {
    try {
      return client.onMessage((message) => {
        if (message.type === "spade.status.changed")
          cache.setQueryData(spadeShownKey, spadeShown(message.status));
      });
    } catch {
      // At the listener limit the answer only refreshes on reconnect.
      return undefined;
    }
  }, [client, cache]);
  return query.data;
}
