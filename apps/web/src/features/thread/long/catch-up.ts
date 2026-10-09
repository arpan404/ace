import type { ClientApi, ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import type { ThreadCatchUpResponse } from "@ace/protocol";
import { catchUpHasNews } from "@ace/ui-core";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { usePageVisible } from "@/lib/page-visibility.ts";
import { useWatched, type ThreadNav } from "./nav.tsx";

/*
 * "While you were away" (ADR 0062): on opening a thread, this device's read cursor says where
 * the reader left it; if the thread moved on since, the daemon's deterministic catch-up digest
 * from that cursor is what the card shows. Reading it never asks a provider anything. While the
 * reader follows the live end of a visible page, the cursor advances (coalesced by the client).
 */

const readCursor = (reader: ThreadReader) => reader.cursor;

export interface CatchUp {
  /** The read cursor the digest starts after. */
  since: number;
  /** When this device last read the thread. */
  sinceAt: number;
  digest: ThreadCatchUpResponse;
}

export function useCatchUp(threadId: string): {
  /** The read cursor has been read (or couldn't be), so marking may start. */
  ready: boolean;
  catchUp: CatchUp | undefined;
  dismiss(): void;
} {
  const read = useDaemonQuery({
    queryKey: ["thread-read", threadId],
    read: (client: ClientApi, signal) => client.threadReadState({ threadId }, { signal }),
    // Read once per visit: the marker moves the cursor while the reader is here.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const cursor = useThread(threadId, ["cursor"], readCursor);
  const state = read.data;
  const since = state?.lastSeenSeq;
  const away =
    state !== undefined &&
    state.updatedAt !== null &&
    since !== undefined &&
    cursor !== undefined &&
    cursor > since;
  const digest = useDaemonQuery({
    queryKey: ["thread-catch-up", threadId, since],
    read: (client: ClientApi, signal) =>
      client.threadCatchUp({ threadId, sinceSeq: since ?? 0 }, { signal }),
    enabled: away,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<number>();
  const data = digest.data;
  const shown =
    away && data && state?.updatedAt != null && dismissed !== since && catchUpHasNews(data)
      ? { since: since ?? 0, sinceAt: state.updatedAt, digest: data }
      : undefined;
  return {
    ready: read.isFetched || read.isError,
    catchUp: shown,
    dismiss: () => setDismissed(since),
  };
}

/**
 * Advance this device's read cursor while the reader follows the live end of a visible page:
 * only what has been on screen counts as read. Writes are monotonic and coalesced by the
 * client; this waits until the thread's cursor settles for a moment.
 */
export function useReadMarker(threadId: string, nav: ThreadNav, ready: boolean): void {
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
