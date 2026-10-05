import type { ClientApi, ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ItemsWindowResponse, ThreadReadStateResponse } from "@ace/protocol";
import { useState } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/*
 * Where the reader left a thread (UX audit SY-13): one record, the daemon's read cursor for
 * this device, which "While you were away" reads too, so the two never disagree and a thread
 * read elsewhere the daemon knows about shows no divider here. The cursor moves while the
 * reader follows the live end of a visible page (`useReadMarker`); the "New activity" divider
 * goes after the last item the cursor had reached.
 */

/** The read cursor, read once per visit (the same query as the catch-up card). */
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
