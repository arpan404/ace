import { startFolder } from "@ace/ui-core";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { Machine } from "@/lib/machines.ts";
import { projectFailure, projectReads } from "./project-commands.ts";

/*
 * Folder reads on one machine, cached per machine. Every read waits for that machine to be
 * online, since folder reads never queue while it is away, and none falls back to another
 * machine.
 */

const folderKey = ["projects", "folders"] as const;

/**
 * The machine's home folder, its allowed roots, `start` (where browsing opens) and Git's
 * initial branch there.
 *
 * Browsing starts at home when an allowed root holds it, else at the first root
 * (`startFolder`). The daemon reports home as written and roots canonical, so a home reached
 * through a symlink can look outside roots that do hold it: then home is read once, and opened
 * if the daemon allows it.
 */
export function useHostHome(machine: Machine) {
  const client = machine.client;
  return useQuery({
    queryKey: [...folderKey, machine.id, "home"],
    queryFn: async ({ signal }) => {
      if (!client) throw new Error("offline");
      const reads = projectReads(client);
      const home = await reads.home(signal);
      const start = startFolder(home.path, home.roots) ?? home.path;
      if (start === home.path) return { ...home, start };
      const readable = await reads.browse({ path: home.path, showHidden: false }, signal).then(
        () => true,
        () => false,
      );
      signal.throwIfAborted();
      return { ...home, start: readable ? home.path : start };
    },
    enabled: client !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

export type HostHome = NonNullable<ReturnType<typeof useHostHome>["data"]>;

/** A registered project on one machine, with its place in that machine's recent order. */
export interface RecentFolder {
  machine: Machine;
  id: string;
  name: string;
  path: string;
  /** 0 for the machine's most recently used project. */
  rank: number;
}

/** How many projects each machine reports: its recent ones, and the badges' "Project". */
const recentLimit = 100;

/**
 * The projects of every online machine, most recently used first on each, interleaved so the
 * top of the list has each machine's latest. Also says whether a folder is a project.
 */
export function useRecentFolders(machines: readonly Machine[]) {
  const answers = useQueries({
    queries: machines.map((machine) => ({
      queryKey: [...folderKey, machine.id, "recent"],
      queryFn: ({ signal }: { signal: AbortSignal }) => {
        if (!machine.client) throw new Error("offline");
        return projectReads(machine.client).recent(recentLimit, signal);
      },
      enabled: machine.client !== undefined,
      staleTime: 10_000,
      // Projects added from another device show the next time the dialog opens.
      refetchOnMount: "always" as const,
      retry: false,
    })),
    combine: answersOf,
  });
  const folders = useMemo(() => merge(machines, answers.data), [machines, answers.data]);
  return { folders, loading: answers.loading, isProject: useProjectTest(folders) };
}

type RecentAnswer = { folders: { id: string; name: string; path: string }[] } | undefined;
const answersOf = (results: { data: RecentAnswer; isPending: boolean; fetchStatus: string }[]) => ({
  data: results.map((result) => result.data),
  loading: results.some((result) => result.isPending && result.fetchStatus === "fetching"),
});

function merge(machines: readonly Machine[], answers: readonly RecentAnswer[]): RecentFolder[] {
  const rows: RecentFolder[] = [];
  machines.forEach((machine, index) =>
    (answers[index]?.folders ?? []).forEach((folder, rank) =>
      rows.push({ machine, id: folder.id, name: folder.name, path: folder.path, rank }),
    ),
  );
  return rows.toSorted((a, b) => a.rank - b.rank);
}

function useProjectTest(folders: readonly RecentFolder[]) {
  return useMemo(() => {
    const known = new Set(folders.map((folder) => `${folder.machine.id}\u0000${folder.path}`));
    return (machine: Machine, path: string) => known.has(`${machine.id}\u0000${path}`);
  }, [folders]);
}

/** Folders read for a big folder before it stops: 50 pages of 100. */
const listingCap = 5_000;

/**
 * Every folder inside `path` on the machine, read a page of 100 at a time until all are in
 * (up to 5,000), so completion and filtering see the whole folder. Dot folders show only with
 * `showHidden`. Failures carry the daemon's code (`projectFailure`).
 */
export function useFolderListing(machine: Machine, path: string | undefined, showHidden: boolean) {
  const client = machine.client;
  const query = useInfiniteQuery({
    queryKey: [...folderKey, machine.id, "browse", path, showHidden],
    queryFn: ({ signal, pageParam }) => {
      if (!client) throw new Error("offline");
      return projectReads(client).browse(
        { path: path ?? "/", showHidden, ...(pageParam ? { after: pageParam } : {}) },
        signal,
      );
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.next,
    enabled: client !== undefined && path !== undefined,
    staleTime: 5_000,
    retry: false,
  });
  const entries = useMemo(() => query.data?.pages.flatMap((page) => page.entries), [query.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const count = entries?.length ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && count < listingCap) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, count, fetchNextPage]);
  return {
    entries,
    error: query.error,
    loading: query.isPending && client !== undefined && path !== undefined,
    offline: client === undefined,
    more: hasNextPage,
    retry: () => void query.refetch(),
  };
}

/** What the daemon knows about a folder: its repository and the root it suggests instead. */
export function useFolderInspection(machine: Machine, path: string | undefined) {
  const client = machine.client;
  return useQuery({
    queryKey: [...folderKey, machine.id, "inspect", path],
    queryFn: ({ signal }) => {
      if (!client) throw new Error("offline");
      return projectReads(client).inspect(path ?? "/", signal);
    },
    enabled: client !== undefined && path !== undefined,
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * The daemon's ranked search of the machine's folders (`fs.search`) for `text`. Keeps the last
 * answer showing while the next one comes, and asks again while the daemon is still indexing.
 */
export function useFolderSearchQuery(machine: Machine, text: string, enabled: boolean) {
  const client = machine.client;
  return useQuery({
    queryKey: [...folderKey, machine.id, "search", text],
    queryFn: ({ signal }) => {
      if (!client) throw new Error("offline");
      return projectReads(client).search(text, signal);
    },
    enabled: enabled && client !== undefined,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === machine.id ? previous : undefined,
    refetchInterval: (query) => (query.state.data?.indexing ? 150 : false),
    staleTime: 5_000,
    // Another picker on this connection superseded it: ask again, once.
    retry: (count, error) => count < 1 && projectFailure(error).code === "search_cancelled",
  });
}
