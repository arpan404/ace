import { readServerQueue, type ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { ThreadId, type QueuePage } from "@ace/protocol";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useDaemonQuery } from "./daemon-query.ts";
import { restoredUnconfirmed } from "./query-persistence.ts";

/** Visible queue rows grow on demand; wire pages remain bounded by the daemon. */
export const queuePageSize = 16;
const queueOf = (reader: ThreadReader) => reader.queue;

export { readServerQueue };

/**
 * One shared read per revision follows the daemon's byte-bounded cursors. Retained inputs
 * must all be known to transcript readers, including rows beyond the visible queue page.
 * Retained queues can exceed current admission limits. Every cursor is fenced to its first page.
 */
export function useServerQueue(threadId: string): {
  page: QueuePage | undefined;
  retained: readonly QueuePage["messages"][number][];
  failed: boolean;
  /** The page is the copy kept from an earlier session, not yet confirmed by the daemon. */
  unconfirmed: boolean;
  loadingMore: boolean;
  loadMore(): void;
  refresh(): void;
} {
  const hold = useThread(threadId, ["queue"], queueOf);
  const [shown, setShown] = useState({ threadId, count: queuePageSize });
  const queries = useQueryClient();
  const query = useDaemonQuery({
    queryKey: ["queue", threadId, hold?.revision ?? -1],
    staleTime: Infinity,
    placeholderData: (previous: QueuePage | undefined) => previous,
    read: (client, signal) =>
      readServerQueue(
        ThreadId.parse(threadId),
        async (request) =>
          (await client.request({ type: "queue.get", ...request }, { signal })).queue,
      ),
  });
  const count = shown.threadId === threadId ? shown.count : queuePageSize;
  const data = query.data?.threadId === threadId ? query.data : undefined;
  const retained = data?.messages ?? [];
  const messages = retained.slice(0, count);
  return {
    page: data
      ? { ...data, messages, next: retained.length > count ? (messages.at(-1)?.id ?? null) : null }
      : undefined,
    retained,
    failed: query.isError,
    // The page shown may be another revision's, carried over while this one is read: what counts
    // is whether the daemon has answered for the data on screen.
    unconfirmed: restoredUnconfirmed(queries, query),
    loadingMore: query.isFetching,
    loadMore: () => setShown({ threadId, count: Math.min(count + queuePageSize, retained.length) }),
    refresh: () => void query.refetch(),
  };
}
