import type { ClientApi, ThreadReader } from "@ace/client";
import { useClient, useThread } from "@ace/client-react";
import type { ThreadReadStateResponse } from "@ace/protocol";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePageVisible } from "@/lib/page-visibility.ts";
import { useWatched, type ThreadNav } from "../long/nav.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

/** The daemon read cursor keeps sidebar unread state in sync while this view follows live. */

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
