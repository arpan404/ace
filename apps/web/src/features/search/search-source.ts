/*
 * Full-text search across threads: `search.query` → `search.results`, paged by the daemon's
 * cursor. Hits keep the protocol's field names (threadId, threadTitle, itemId, workspaceId,
 * provider, kind, createdAt, snippet with UTF-16 highlights). The screen filters by the kinds
 * it offers; the daemon indexes more.
 */
import type { ClientApi } from "@ace/client";
import { useClient, useConnectionState } from "@ace/client-react";
import { ThreadId, type ProviderKind } from "@ace/protocol";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

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

const kinds = new Set<string>(["thread", "message", "tool_call", "artifact"]);
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
  search_failed: "The daemon couldn't search right now.",
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
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<Page> {
  const reply = await client.request(
    {
      type: "search.query",
      text: query,
      limit: pageSize,
      filters: kind ? { kind } : {},
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
              snippet: hit.snippet,
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
export function useSearch(text: string, kind: SearchKind | undefined) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const query = text.trim();
  const result = useInfiniteQuery({
    queryKey: ["search", query, kind ?? "all"],
    enabled: ready && query.length > 0,
    placeholderData: keepPreviousData,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: Page) => last.cursor ?? undefined,
    queryFn: ({ pageParam, signal }) => readPage(client, query, kind, pageParam, signal),
  });
  const hits = useMemo(() => result.data?.pages.flatMap((page) => page.hits), [result.data]);
  return {
    hits,
    error: result.error,
    isError: result.isError,
    refetch: result.refetch,
    updating: result.isPlaceholderData,
    hasMore: result.hasNextPage,
    loadingMore: result.isFetchingNextPage,
    loadMore: () => void result.fetchNextPage(),
  };
}

/**
 * The hit's place in its thread, so the thread opens at it: its item's sequence, found through
 * the thread's own search. Undefined when the hit isn't an item or the thread no longer has it.
 */
export async function hitSeq(
  client: ClientApi,
  hit: SearchHit,
  query: string,
): Promise<number | undefined> {
  if (!hit.itemId || !query) return undefined;
  try {
    const reply = await client.threadSearch({
      threadId: ThreadId.parse(hit.threadId),
      text: query,
      limit: 100,
    });
    return reply.hits.find((candidate) => candidate.itemId === hit.itemId)?.seq;
  } catch {
    return undefined;
  }
}
