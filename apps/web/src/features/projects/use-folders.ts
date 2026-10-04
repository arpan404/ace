import { useClient, useConnectionState } from "@ace/client-react";
import { startFolder } from "@ace/ui-core";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { projectReads } from "./project-commands.ts";

const folderKey = ["projects", "folders"] as const;

/** The host's answer plus `start`, the folder browsing opens at (`startFolder`). */
const withStart = <T extends { path: string; roots: readonly string[] }>(home: T) => ({
  ...home,
  start: startFolder(home.path, home.roots) ?? home.path,
});

/**
 * The daemon host's home folder, its allowed roots, where browsing starts and Git's initial
 * branch there. Waits for a ready connection, since folder reads never queue while offline.
 */
export function useHostHome() {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  return useQuery({
    queryKey: [...folderKey, "home"],
    queryFn: ({ signal }) => projectReads(client).home(signal),
    select: withStart,
    enabled: ready,
    staleTime: 60_000,
    retry: false,
  });
}

/** The folders of the projects used most recently on this daemon. */
export function useRecentFolders() {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  return useQuery({
    queryKey: [...folderKey, "recent"],
    queryFn: ({ signal }) => projectReads(client).recent(signal),
    enabled: ready,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * The folders inside `path`, a page of 100 at a time (`loadMore` for the next). Dot folders
 * show only with `showHidden`. Failures carry the daemon's code (`projectFailure`).
 */
export function useFolderListing(path: string | undefined, showHidden: boolean) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const query = useInfiniteQuery({
    queryKey: [...folderKey, "browse", path, showHidden],
    queryFn: ({ signal, pageParam }) =>
      projectReads(client).browse(
        { path: path ?? "/", showHidden, ...(pageParam ? { after: pageParam } : {}) },
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.next,
    enabled: ready && path !== undefined,
    staleTime: 5_000,
    retry: false,
  });
  const entries = useMemo(() => query.data?.pages.flatMap((page) => page.entries), [query.data]);
  return {
    entries,
    /** The canonical path the daemon listed (a symlink resolves to its target). */
    listed: query.data?.pages[0]?.path,
    error: query.error,
    loading: query.isPending && ready,
    offline: !ready,
    more: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
    retry: () => void query.refetch(),
  };
}

/** What the daemon knows about a folder: its repository and the root it suggests instead. */
export function useFolderInspection(path: string | undefined) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  return useQuery({
    queryKey: [...folderKey, "inspect", path],
    queryFn: ({ signal }) => projectReads(client).inspect(path ?? "/", signal),
    enabled: ready && path !== undefined,
    staleTime: 5_000,
    retry: false,
  });
}
