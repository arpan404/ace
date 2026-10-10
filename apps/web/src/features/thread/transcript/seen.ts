import type { ClientApi, ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import type { ItemsWindowResponse, ThreadReadStateResponse } from "@ace/protocol";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePageVisible } from "@/lib/page-visibility.ts";
import { useWatched, type ThreadNav } from "../long/nav.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/*
 * Where the reader left a thread (UX audit SY-13): one record, the daemon's read cursor for
 * this device, so a thread read elsewhere the daemon knows about shows no divider here. The cursor moves while the
 * reader follows the live end of a visible page (`useReadMarker`); the "New activity" divider
 * goes after the last item the cursor had reached.
 */

/** The read cursor, read once per visit. */
function useReadState(threadId: string) {
  return useDaemonQuery({
    queryKey: ["thread-read", threadId],
    read: (client: ClientApi, signal): Promise<ThreadReadStateResponse> =>
      client.threadReadState({ threadId }, { signal }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

/**
 * The item the read cursor had reached: the newest in the window around it whose creation
 * sequence is at or before the cursor. Pure.
 */
export function itemAtCursor(
  window: Pick<ItemsWindowResponse, "itemSeqs">,
  lastSeenSeq: number,
): string | undefined {
  let found: { id: string; seq: number } | undefined;
  for (const [id, seq] of Object.entries(window.itemSeqs))
    if (seq <= lastSeenSeq && (!found || seq > found.seq)) found = { id, seq };
  return found?.id;
}

const readCursor = (reader: ThreadReader) => reader.cursor;

/** Mark only a visible thread whose reader follows the live end; writes stay coalesced. */
export function useReadMarker(threadId: string, nav: ThreadNav): void {
  const read = useReadState(threadId);
  const ready = read.isFetched || read.isError;
  const queryClient = useQueryClient();
  const client = useClient();
  const following = useWatched(nav.following);
  const visible = usePageVisible();
  const cursor = useThread(threadId, ["cursor"], readCursor);
  useEffect(() => {
    if (!ready || !following || !visible || !cursor) return;
    const timer = setTimeout(
      () =>
        void client
          .markThreadRead({ threadId, lastSeenSeq: cursor })
          .then(() =>
            queryClient.invalidateQueries({ queryKey: ["sidebar-thread-read", threadId] }),
          )
          .catch(() => {}),
      800,
    );
    return () => clearTimeout(timer);
  }, [client, queryClient, threadId, ready, following, visible, cursor]);
}

/**
 * The item the reader had seen when this visit began, when anything arrived since; undefined
 * when nothing is new or the thread was never read on this device. Decided once per visit, from
 * the cursor as it was on arrival, and kept while the cursor moves on.
 */
export function useLastSeen(threadId: string): string | undefined {
  const read = useReadState(threadId).data;
  const cursor = useThread(threadId, ["cursor"], readCursor);
  const since = read && read.updatedAt !== null ? read.lastSeenSeq : undefined;
  const behind = since !== undefined && cursor !== undefined && cursor > since;
  // Only a thread with news asks which item the cursor had reached.
  const window = useDaemonQuery({
    queryKey: ["thread-seen", threadId, since],
    read: (client: ClientApi, signal) =>
      client.itemsWindow({ threadId, aroundSeq: since ?? 0, before: 1, after: 0 }, { signal }),
    enabled: behind,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  }).data;
  const [kept, setKept] = useState<{ itemId: string | undefined }>();
  if (!kept && window && since !== undefined) setKept({ itemId: itemAtCursor(window, since) });
  return kept?.itemId;
}
