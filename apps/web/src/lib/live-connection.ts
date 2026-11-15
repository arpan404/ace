import type { ClientApi, SidebarReader, ThreadReader } from "@ace/client";
import {
  useClient,
  useConnectionState,
  useSidebar,
  useSidebarUnconfirmed,
  useThreadSyncing,
  useThreadUnconfirmed,
} from "@ace/client-react";
import { useCallback } from "react";

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

/**
 * The one rule behind every gate below: what a store holds is current only while the connection
 * is ready, the daemon has confirmed it and its subscription has caught up. Pure.
 */
export function isCurrent(
  ready: boolean,
  copy: { unconfirmed?: boolean; syncing?: boolean } | undefined,
): boolean {
  return ready && copy?.unconfirmed !== true && copy?.syncing !== true;
}

/**
 * The gates read as an action runs, outside React: a thread's copy (`threadId`) or the thread
 * list (no `threadId`). A thread the client holds no copy of is never current.
 */
export function currentNow(client: ClientApi, threadId?: string): boolean {
  const ready = client.state === "ready";
  if (threadId === undefined) {
    const list = client.cachedThreads?.();
    if (list) return isCurrent(ready, list);
    const lease = client.threads();
    try {
      return isCurrent(ready, lease.store);
    } finally {
      lease.release();
    }
  }
  // Read, not kept: checking a thread must not itself keep its copy cached.
  const copy: ThreadReader | undefined =
    client.peekThread?.(threadId) ?? client.cachedThread?.(threadId);
  return copy !== undefined && isCurrent(ready, copy);
}

/** What a thread copy the daemon hasn't confirmed says, as the transcript's live line does. */
export const syncingLabel = "Syncing…";

/**
 * The words a surface shows instead of any state, terminal ones included, while what it reads
 * isn't current (`fresh` from the gate that matches its data): the connection's word, else
 * "Syncing…". Undefined while fresh. A done or failed thread can be resumed, so no state is
 * safe to claim from a stale copy.
 */
export function useStaleWord(fresh: boolean): string | undefined {
  const connection = useLiveConnection();
  return fresh ? undefined : (connection.staleLabel ?? syncingLabel);
}

/**
 * The one gate for anything that shows a thread's live state or acts on it (features read it
 * through `useThreadLiveState`). A thread's copy is `fresh` only while the connection is ready,
 * the daemon has confirmed the copy (not one read back from disk) and its subscription has caught
 * up since the last reconnect (`syncing`: after the welcome, the replay or snapshot may still be
 * on its way, and until it lands the copy says what was true before the drop). Otherwise a surface shows
 * `staleLabel` ("Reconnecting…", "Offline", "Syncing…") in place of "Working", "Waiting on you",
 * "Done" or a timer, and an action on what it shows (an answer, a Stop, a queue edit) waits.
 */
export function useThreadFreshness(threadId: string | undefined): {
  fresh: boolean;
  staleLabel: string | undefined;
  /**
   * Whether the copy is current when called, read from the client and its store (`currentNow`),
   * never from what was last drawn: for an action deciding as it runs.
   */
  isFresh(): boolean;
} {
  const client = useClient();
  const connection = useLiveConnection();
  const unconfirmed = useThreadUnconfirmed(threadId);
  const syncing = useThreadSyncing(threadId);
  const fresh = isCurrent(connection.fresh, { unconfirmed, syncing });
  const isFresh = useCallback(
    () => (threadId === undefined ? client.state === "ready" : currentNow(client, threadId)),
    [client, threadId],
  );
  return {
    fresh,
    staleLabel: fresh ? undefined : (connection.staleLabel ?? syncingLabel),
    isFresh,
  };
}

/**
 * The thread list's sibling of `useThreadFreshness`: its entries are current only while the
 * connection is ready, the daemon has confirmed the list and its subscription has caught up. Surfaces outside the sidebar that
 * read list entries (a pull request's agent chip, "Agent fixing this") claim no status otherwise,
 * as the sidebar's own rows don't.
 */
export function useLiveList(): boolean {
  return useListFreshness().fresh;
}

/** `useLiveList` with a reader of it as it is when an action runs (`isFresh`). */
export function useListFreshness(): { fresh: boolean; isFresh(): boolean } {
  const connection = useLiveConnection();
  const unconfirmed = useSidebarUnconfirmed();
  const syncing = useSidebar(["sync"], readListSyncing) ?? false;
  const fresh = isCurrent(connection.fresh, { unconfirmed, syncing });
  const client = useClient();
  return { fresh, isFresh: useCallback(() => currentNow(client), [client]) };
}
const readListSyncing = (reader: SidebarReader) => reader.syncing ?? false;
