import { useConnectionState, useSidebarUnconfirmed, useThreadUnconfirmed } from "@ace/client-react";

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

/** What a thread copy the daemon hasn't confirmed says, as the transcript's live line does. */
export const syncingLabel = "Syncing…";

/**
 * The one gate for anything that shows a thread's live state or acts on it (features read it
 * through `useThreadLiveState`). A thread's copy is `fresh` only while the connection is ready
 * and the daemon has confirmed the copy (not one read back from disk). Otherwise a surface shows
 * `staleLabel` ("Reconnecting…", "Offline", "Syncing…") in place of "Working", "Waiting on you",
 * "Done" or a timer, and an action on what it shows (an answer, a Stop, a queue edit) waits.
 */
export function useThreadFreshness(threadId: string | undefined): {
  fresh: boolean;
  staleLabel: string | undefined;
} {
  const connection = useLiveConnection();
  const unconfirmed = useThreadUnconfirmed(threadId);
  const fresh = connection.fresh && !unconfirmed;
  return { fresh, staleLabel: fresh ? undefined : (connection.staleLabel ?? syncingLabel) };
}

/**
 * The thread list's sibling of `useThreadFreshness`: its entries are current only while the
 * connection is ready and the daemon has confirmed the list. Surfaces outside the sidebar that
 * read list entries (a pull request's agent chip, "Agent fixing this") claim no status otherwise,
 * as the sidebar's own rows don't.
 */
export function useLiveList(): boolean {
  const connection = useLiveConnection();
  const unconfirmed = useSidebarUnconfirmed();
  return connection.fresh && !unconfirmed;
}
