import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { ThreadId, type QueuePage } from "@ace/protocol";
import { useDaemonQuery } from "./daemon-query.ts";

/** Messages a composer shows at once; the rest are counted. The daemon pages at most 32. */
export const queuePageSize = 16;

const queueOf = (reader: ThreadReader) => reader.queue;

/**
 * A thread's server queue (ADR 0053): the hold and revision arrive live on the thread
 * (`queue.updated`), and the first page of messages is read again whenever the revision moves.
 * Every reader (the composer's pills, the Agents tab) shares the one read per revision.
 */
export function useServerQueue(threadId: string): {
  /** The first page at the current revision; undefined until read. */
  page: QueuePage | undefined;
  failed: boolean;
  refresh(): void;
} {
  const hold = useThread(threadId, ["queue"], queueOf);
  const query = useDaemonQuery({
    queryKey: ["queue", threadId, hold?.revision ?? -1],
    staleTime: Infinity,
    // A page older than the live revision is about to be replaced; keep showing it meanwhile.
    placeholderData: (previous: QueuePage | undefined) => previous,
    read: async (client, signal): Promise<QueuePage> =>
      (
        await client.request(
          { type: "queue.get", threadId: ThreadId.parse(threadId), limit: queuePageSize },
          { signal },
        )
      ).queue,
  });
  return {
    page: query.data,
    failed: query.isError,
    refresh: () => void query.refetch(),
  };
}
