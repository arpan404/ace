import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { ThreadId, type QueueGet, type QueuePage } from "@ace/protocol";
import { useState } from "react";
import { useDaemonQuery } from "./daemon-query.ts";

/** Visible queue rows grow on demand; wire pages remain bounded by the daemon. */
export const queuePageSize = 16;
const queueOf = (reader: ThreadReader) => reader.queue;

type ReadQueue = (
  request: Pick<QueueGet, "threadId" | "limit" | "after" | "expectedRevision">,
) => Promise<QueuePage>;

export async function readServerQueue(threadId: ThreadId, read: ReadQueue): Promise<QueuePage> {
  const first = await read({ threadId, limit: 32 });
  const messages = [...first.messages];
  let next = first.next;
  const cursors = new Set<string>();
  while (next !== null) {
    if (cursors.has(next) || messages.length >= 256) throw new Error("invalid_queue_cursor");
    cursors.add(next);
    const page = await read({ threadId, limit: 32, after: next, expectedRevision: first.revision });
    if (page.revision !== first.revision) throw new Error("queue_conflict");
    messages.push(...page.messages);
    next = page.next;
  }
  return { ...first, messages, next: null };
}

/**
 * One shared read per revision follows the daemon's byte-bounded cursors. Retained inputs
 * must all be known to transcript readers, including rows beyond the visible queue page.
 * The server limits a thread to 256 retained inputs. Every cursor is fenced to its first page.
 */
export function useServerQueue(threadId: string): {
  page: QueuePage | undefined;
  retained: readonly QueuePage["messages"][number][];
  failed: boolean;
  loadingMore: boolean;
  loadMore(): void;
  refresh(): void;
} {
  const hold = useThread(threadId, ["queue"], queueOf);
  const [shown, setShown] = useState({ threadId, count: queuePageSize });
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
    loadingMore: query.isFetching,
    loadMore: () => setShown({ threadId, count: Math.min(count + queuePageSize, 256) }),
    refresh: () => void query.refetch(),
  };
}
