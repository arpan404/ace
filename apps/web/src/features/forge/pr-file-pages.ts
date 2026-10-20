import { useCallback, useEffect, useMemo } from "react";
import { hashKey, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ForgePrDetail, ForgePrFiles, ForgeRepository } from "@ace/protocol";
import { refreshOnReconnect } from "@/lib/daemon-query-reconnect.ts";
import { joinFilePages } from "./pr-code-model.ts";
import { readForge } from "./source.ts";

/**
 * A pull request's changed files (all commits, or one commit against its parent), read page by
 * page as the person scrolls. Like every daemon read it waits for a ready connection and reads
 * again after a reconnect; a page that failed stays failed until `retry`.
 */
export function usePrFilePages(props: {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
  commit: string;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const cache = useQueryClient();
  const ref = props.detail.status.ref;
  const queryKey = [
    "forge",
    props.workspaceId,
    ref,
    "file-pages",
    props.detail.baseSha,
    props.detail.status.headSha,
    props.commit,
  ];
  const query = useInfiniteQuery({
    queryKey,
    meta: { daemonClient: client },
    enabled: ready,
    retry: false,
    initialPageParam: 1,
    getNextPageParam: (page: ForgePrFiles, _pages, current: number) =>
      page.nextPage && page.nextPage > current ? page.nextPage : undefined,
    queryFn: async ({ pageParam, signal }): Promise<ForgePrFiles> => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.files",
          workspaceId: props.workspaceId,
          repository: props.repository,
          number: ref.number,
          headSha: props.detail.status.headSha,
          baseSha: props.detail.baseSha,
          page: pageParam,
          ...(props.commit ? { commit: props.commit } : {}),
        },
        signal,
      );
      if (result.resource !== "prFiles") throw new Error("No changed-file response.");
      return result.value;
    },
  });
  const hash = hashKey(queryKey);
  useEffect(() => refreshOnReconnect(client, cache, hash), [client, cache, hash]);
  const pages = query.data?.pages;
  const range = useMemo(() => (pages ? joinFilePages(pages) : undefined), [pages]);
  const { fetchNextPage, hasNextPage, isFetchingNextPage, isFetchNextPageError, refetch } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError)
      void fetchNextPage({ cancelRefetch: false });
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const hasPages = pages !== undefined;
  const retry = useCallback(() => {
    if (hasPages) void fetchNextPage({ cancelRefetch: false });
    else void refetch();
  }, [hasPages, fetchNextPage, refetch]);
  return {
    /** Every file read so far, as one range; undefined before the first page. */
    range,
    /** How many pages have loaded: a new page re-arms the scroll sentinel. */
    loaded: pages?.length ?? 0,
    /** The first page failed: nothing to show. */
    error: query.isError && !hasPages ? query.error : undefined,
    pending: !hasPages && !query.isError,
    more: !hasNextPage
      ? ("done" as const)
      : isFetchNextPageError
        ? ("failed" as const)
        : isFetchingNextPage
          ? ("loading" as const)
          : ("idle" as const),
    loadMore,
    retry,
  };
}
