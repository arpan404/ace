import type { ClientApi } from "@ace/client";
import type { ThreadReadStateResponse } from "@ace/protocol";
import { useDaemonQuery } from "./daemon-query.ts";

/**
 * This device's read cursor for a thread as it stood when the visit began (ADR 0062): read once
 * per visit and dropped when nothing shows the thread, so marking the thread read while the
 * person follows it never moves the cursor a visit compares against. The transcript's read
 * marker and the Summary's catch-up share it.
 */
export function useVisitReadState(threadId: string) {
  return useDaemonQuery({
    queryKey: ["thread-read", threadId],
    read: (client: ClientApi, signal): Promise<ThreadReadStateResponse> =>
      client.threadReadState({ threadId }, { signal }),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}
