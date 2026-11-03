import { useCallback, useEffect, useMemo } from "react";
import { hashKey, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ForgePrDetail, ForgePrFiles, ForgeRepository } from "@ace/protocol";
import { refreshOnReconnect } from "@/lib/daemon-query-reconnect.ts";
import { joinFilePages } from "./pr-code-model.ts";
import { readForge } from "@/lib/forge-read.ts";
import { prContentStaleMs } from "@/lib/forge-pr-detail.ts";

/** The cache key of a range's file pages; All commits is `commit` "". */
function filePagesKey(workspaceId: string, detail: ForgePrDetail, commit: string, since?: string) {
  return [
    "forge",
    workspaceId,
    detail.status.ref,
    "file-pages",
    detail.baseSha,
    detail.status.headSha,
    since ? `${since}..${commit}` : commit,
  ];
}

/**
 * GitHub's patch of a file across All commits, from the pages already read: a comment made
 * in a commit view must sit on lines of this patch. Undefined while those pages aren't read.
 */
export function usePrPatchOf(workspaceId: string, detail: ForgePrDetail) {
  const cache = useQueryClient();
  return (path: string): string | null | undefined => {
    const data = cache.getQueryData<{ pages: ForgePrFiles[] }>(filePagesKey(workspaceId, detail, ""));
    for (const page of data?.pages ?? []) {
      const file = page.files.find((each) => each.path === path);
      if (file) return file.truncated ? null : file.patch;
    }
    return undefined;
  };
}

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
  /** With `commit`: the commits after this one, through `commit`. */
  since?: string | undefined;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const cache = useQueryClient();
  const ref = props.detail.status.ref;
  const queryKey = filePagesKey(props.workspaceId, props.detail, props.commit, props.since);
  const query = useInfiniteQuery({
    queryKey,
    meta: { daemonClient: client },
    enabled: ready,
    retry: false,
    staleTime: prContentStaleMs,
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
          ...(props.commit && props.since ? { since: props.since } : {}),
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
