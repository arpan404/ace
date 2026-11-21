/*
 * Full-text search across threads: `search.query` → `search.results`, paged by the daemon's
 * cursor. Hits keep the protocol's field names (threadId, threadTitle, itemId, workspaceId,
 * provider, kind, createdAt, snippet with UTF-16 highlights). The screen filters by the kinds
 * it offers; the daemon indexes more.
 */
import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import { ThreadId, type ProviderKind, type SearchQuery } from "@ace/protocol";
import { keepPreviousData, useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useMachinesInSpace, usePrimaryInSpace, type Machine } from "@/lib/machines.ts";
import { spaceKey, useSpaceScope } from "@/lib/space-scope.ts";

export type SearchKind = "thread" | "message" | "tool_call" | "artifact" | "html";
export interface SearchHit {
  threadId: string;
  threadTitle: string;
  /** The item the hit is in, when it is one (not a thread title). */
  itemId: string | undefined;
  workspaceId: string;
  provider: ProviderKind;
  kind: SearchKind;
  createdAt: number;
  snippet: { text: string; highlights: readonly { start: number; end: number }[] };
  /** Another machine of the window's space the hit is on; none for this window's own. */
  machine?: { id: string; name: string } | undefined;
}

const shownKinds: SearchKind[] = ["thread", "message", "tool_call", "artifact", "html"];
const kinds = new Set<string>(shownKinds);
const shown = (hit: { kind: string }): hit is { kind: SearchKind } => kinds.has(hit.kind);

/** A search the daemon refused, in words; other failures go through `describeDaemonError`. */
export class SearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchError";
  }
}

const errors: Record<string, string> = {
  search_invalid_query: "That search can't be run. Try fewer or simpler words.",
  search_cursor_stale: "The index changed while you were reading. Search again.",
  search_failed: "Search couldn't finish. Try again.",
};

/** Results per page; "Show more" reads the next. */
export const pageSize = 50;

interface Page {
  hits: SearchHit[];
  cursor: string | null;
}

async function readPage(
  client: ClientApi,
  query: string,
  kind: SearchKind | undefined,
  filters: SearchQuery["filters"],
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<Page> {
  const reply = await client.request(
    {
      type: "search.query",
      text: query,
      limit: pageSize,
      filters: { ...filters, ...(kind ? { kind } : { kinds: shownKinds }) },
      ...(cursor ? { cursor } : {}),
    },
    { signal },
  );
  if (reply.type === "search.error") throw new SearchError(errors[reply.code] ?? reply.code);
  return {
    cursor: reply.cursor,
    hits: reply.hits.flatMap((hit) =>
      shown(hit)
        ? [
            {
              threadId: hit.threadId,
              threadTitle: hit.threadTitle,
              itemId: hit.itemId,
              workspaceId: hit.workspaceId,
              provider: hit.provider,
              kind: hit.kind,
              createdAt: hit.createdAt,
              snippet: hit.kind === "thread" ? hit.title : hit.snippet,
            },
          ]
        : [],
    ),
  };
}

const noHits: SearchHit[] = [];
const noMachines: readonly Machine[] = [];
/** How long another machine's search may take before its hits are left out. */
const machineTimeoutMs = 15_000;

interface MachineResults {
  /** Each machine's first page, once it answered; undefined while asked or when it failed. */
  hits: (SearchHit[] | undefined)[];
  /** Some machine answered or failed: what answered can be shown. */
  settled: boolean;
  updating: boolean;
}
const combineMachines = (
  results: readonly {
    data?: SearchHit[] | undefined;
    isError: boolean;
    isPlaceholderData: boolean;
  }[],
): MachineResults => ({
  hits: results.map((result) => result.data),
  settled: results.some((result) => result.data !== undefined || result.isError),
  updating: results.some((result) => result.isPlaceholderData),
});

/**
 * The first page of hits from each other machine of the window's space (ADR 0206 §2.4), as the
 * palette asks them for threads: each is cached under the space and its host id, marked with its
 * machine, and one that fails or doesn't answer in time leaves only its own hits out.
 */
function useMachineSearch(
  machines: readonly Machine[],
  query: string,
  kind: SearchKind | undefined,
  filters: SearchQuery["filters"],
  space: string,
): MachineResults {
  return useQueries({
    queries: machines.map((machine) => ({
      queryKey: ["search", space, machine.id, query, kind ?? "all", filters],
      enabled: query.length > 0 && machine.client !== undefined,
      placeholderData: keepPreviousData,
      retry: false,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        if (!machine.client) return [];
        const within = AbortSignal.any([signal, AbortSignal.timeout(machineTimeoutMs)]);
        const page = await readPage(machine.client, query, kind, filters, undefined, within);
        const on = { id: machine.id, name: machine.name };
        // Each hit is this query's own object, so it is marked in place.
        for (const hit of page.hits) hit.machine = on;
        return page.hits;
      },
    })),
    combine: combineMachines,
  });
}

/**
 * The hits for `text`, a page at a time. While a new query loads the last results stay, marked
 * `updating`, so the list never blanks between keystrokes. Every machine of the window's space is
 * searched (ADR 0206 §2.4): this daemon while it is one of them, page by page, then the first
 * page of each other one online. The hits are kept per space, so one space's never show in
 * another. A project filter names one of this daemon's projects, so it asks this daemon alone.
 */
export function useSearch(
  text: string,
  kind: SearchKind | undefined,
  filters: SearchQuery["filters"] = {},
) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const query = text.trim();
  const ownShown = usePrimaryInSpace();
  const space = spaceKey(useSpaceScope());
  const inSpace = useMachinesInSpace();
  const others = useMemo(() => {
    if (filters.workspaceId) return noMachines;
    const online = inSpace.filter((machine) => !machine.primary && machine.client);
    return online.length ? online : noMachines;
  }, [inSpace, filters.workspaceId]);
  const elsewhere = useMachineSearch(others, query, kind, filters, space);
  const progress = useDaemonQuery({
    queryKey: ["search-status"],
    read: async (api, signal) => {
      const reply = await api.request({ type: "search.status" }, { signal });
      if (reply.type === "search.error") throw new SearchError("Couldn't check search progress.");
      return reply;
    },
    refetchInterval: (state) => (state.state.data?.ready ? 30_000 : 1_000),
  });
  const result = useInfiniteQuery({
    queryKey: ["search", space, query, kind ?? "all", filters, progress.data?.generation],
    enabled: ready && ownShown && query.length > 0,
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page) => last.cursor ?? undefined,
    queryFn: ({ pageParam, signal }) => readPage(client, query, kind, filters, pageParam, signal),
  });
  const own = useMemo(() => result.data?.pages.flatMap((page) => page.hits), [result.data]);
  const hits = useMemo(() => {
    const theirs = elsewhere.hits.flatMap((each) => each ?? []);
    if (ownShown) return own && (theirs.length ? [...own, ...theirs] : own);
    if (!others.length) return noHits;
    // Nothing yet while every machine is still asked; then whatever answered.
    return elsewhere.settled ? theirs : undefined;
  }, [ownShown, own, others, elsewhere]);
  return {
    hits,
    progress: ownShown ? progress.data : undefined,
    error: result.error,
    isError: result.isError,
    refetch: result.refetch,
    updating: result.isPlaceholderData || elsewhere.updating,
    hasMore: result.hasNextPage,
    loadingMore: result.isFetchingNextPage,
    loadMore: () => void result.fetchNextPage(),
  };
}

/** How many pages of the thread's own search are read to place a hit (100 matches each). */
export const seqPages = 20;

/**
 * The hit's place in its thread, so the thread opens at it: its item's sequence, found by
 * paging the thread's own search for the same words until that item comes up (at most
 * `seqPages` pages). Undefined when the hit isn't an item, or the thread no longer has it.
 */
export async function hitSeq(
  client: Pick<ClientApi, "threadSearch">,
  hit: Pick<SearchHit, "threadId" | "itemId">,
  query: string,
): Promise<number | undefined> {
  if (!hit.itemId || !query) return undefined;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < seqPages; page++) {
      const reply = await client.threadSearch({
        threadId: ThreadId.parse(hit.threadId),
        text: query,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const found = reply.hits.find((candidate) => candidate.itemId === hit.itemId);
      if (found) return found.seq;
      if (!reply.cursor) return undefined;
      cursor = reply.cursor;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
