import type { ClientApi, SidebarReader, ThreadReader } from "@ace/client";
import {
  useConnectionState,
  useSidebar,
  useSidebarUnconfirmed,
  useThreadSyncing,
  useThreadUnconfirmed,
} from "@ace/client-react";
import { useCallback, useLayoutEffect, useRef } from "react";

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
    const lease = client.threads();
    try {
      return isCurrent(ready, lease.store);
    } finally {
      lease.release();
    }
  }
  const copy: ThreadReader | undefined = client.cachedThread?.(threadId);
  return copy !== undefined && isCurrent(ready, copy);
}

/** What a thread copy the daemon hasn't confirmed says, as the transcript's live line does. */
export const syncingLabel = "Syncing…";

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
  /** `fresh` as it is when called: an action checks it as it runs, not as it was drawn. */
  isFresh(): boolean;
} {
  const connection = useLiveConnection();
  const unconfirmed = useThreadUnconfirmed(threadId);
  const syncing = useThreadSyncing(threadId);
  const fresh = isCurrent(connection.fresh, { unconfirmed, syncing });
  const isFresh = useLatest(fresh);
  return {
    fresh,
    staleLabel: fresh ? undefined : (connection.staleLabel ?? syncingLabel),
    isFresh,
  };
}

/** A reader of `value` as last committed, stable across renders. */
function useLatest(value: boolean): () => boolean {
  const latest = useRef(value);
  useLayoutEffect(() => {
    latest.current = value;
  }, [value]);
  return useCallback(() => latest.current, []);
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
  return { fresh, isFresh: useLatest(fresh) };
}
const readListSyncing = (reader: SidebarReader) => reader.syncing ?? false;
