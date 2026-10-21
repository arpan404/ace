import { useEffect, useRef } from "react";
import type { ClientApi } from "@ace/client";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { prContentStaleMs } from "@/lib/forge-pr-detail.ts";

/**
 * A long PR history read page by page. The first read shows each page as it arrives. A later
 * read (the PR moved on, or its kept copy is read again) keeps showing what was loaded until
 * the new history is whole, so the list never shrinks back to one page.
 */
export function useHistoryQuery<T extends { complete: boolean }>(options: {
  /** `["forge", workspaceId, ref, kind, ...version]`: the first four name whose history it is. */
  queryKey: QueryKey;
  enabled?: boolean;
  gcTime?: number;
  read(client: ClientApi, signal: AbortSignal, progress: (partial: T) => void): Promise<T>;
}) {
  const cache = useQueryClient();
  const { queryKey, read, ...rest } = options;
  // Whether an earlier key's history is shown while this one is read.
  const earlier = useRef(false);
  const query = useDaemonQuery<T>({
    ...rest,
    queryKey,
    retry: false,
    staleTime: prContentStaleMs,
    // Another version of the same PR's history stands in; another PR's never does.
    placeholderData: (previous, previousQuery) =>
      previousQuery && hashKey(previousQuery.queryKey.slice(0, 4)) === hashKey(queryKey.slice(0, 4))
        ? previous
        : undefined,
    read: (client, signal) =>
      read(client, signal, (partial) => {
        if (signal.aborted || earlier.current) return;
        if (cache.getQueryData<T>(queryKey)?.complete) return;
        cache.setQueryData(queryKey, partial);
      }),
  });
  useEffect(() => {
    earlier.current = query.isPlaceholderData;
  }, [query.isPlaceholderData]);
  return query;
}
