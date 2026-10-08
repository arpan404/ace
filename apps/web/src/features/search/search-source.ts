/*
 * Full-text search across threads: `search.query` → `search.results`, paged by the daemon's
 * cursor. Hits keep the protocol's field names (threadId, threadTitle, itemId, workspaceId,
 * provider, kind, createdAt, snippet with UTF-16 highlights). The screen filters by the kinds
 * it offers; the daemon indexes more.
 */
import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import { ThreadId, type ProviderKind, type SearchQuery } from "@ace/protocol";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

export type SearchKind = "thread" | "message" | "tool_call" | "artifact";
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
}

const shownKinds: SearchKind[] = ["thread", "message", "tool_call", "artifact"];
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

/**
 * The hits for `text`, a page at a time. While a new query loads the last results stay, marked
 * `updating`, so the list never blanks between keystrokes.
 */
export function useSearch(
  text: string,
  kind: SearchKind | undefined,
  filters: SearchQuery["filters"] = {},
) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const query = text.trim();
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
    queryKey: ["search", query, kind ?? "all", filters, progress.data?.generation],
    enabled: ready && query.length > 0,
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page) => last.cursor ?? undefined,
    queryFn: ({ pageParam, signal }) => readPage(client, query, kind, filters, pageParam, signal),
  });
  const hits = useMemo(() => result.data?.pages.flatMap((page) => page.hits), [result.data]);
  return {
    hits,
    progress: progress.data,
    error: result.error,
    isError: result.isError,
    refetch: result.refetch,
    updating: result.isPlaceholderData,
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
