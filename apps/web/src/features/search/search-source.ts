/*
 * Full-text search across threads: `search.query` → `search.results`. Hits keep the protocol's
 * field names (threadId, threadTitle, workspaceId, provider, kind, createdAt, snippet with UTF-16
 * highlights). The screen filters by the kinds it offers; the daemon indexes more.
 */
import type { ProviderKind } from "@ace/protocol";
import { keepPreviousData } from "@tanstack/react-query";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

export type SearchKind = "thread" | "message" | "tool_call" | "artifact";
export interface SearchHit {
  threadId: string;
  threadTitle: string;
  workspaceId: string;
  provider: ProviderKind;
  kind: SearchKind;
  createdAt: number;
  snippet: { text: string; highlights: readonly { start: number; end: number }[] };
}

const kinds = new Set<string>(["thread", "message", "tool_call", "artifact"]);
const shown = (hit: { kind: string }): hit is { kind: SearchKind } => kinds.has(hit.kind);

const errors: Record<string, string> = {
  search_invalid_query: "That search can't be run. Try fewer or simpler words.",
  search_cursor_stale: "The index changed while you were reading. Search again.",
  search_failed: "The daemon couldn't search right now.",
};

export function useSearch(text: string, kind: SearchKind | undefined) {
  const query = text.trim();
  return useDaemonQuery({
    queryKey: ["search", query, kind ?? "all"],
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    read: async (client, signal): Promise<SearchHit[]> => {
      const reply = await client.request(
        {
          type: "search.query",
          text: query,
          limit: 50,
          filters: kind ? { kind } : {},
        },
        { signal },
      );
      if (reply.type === "search.error") throw new Error(errors[reply.code] ?? reply.code);
      return reply.hits.flatMap((hit) =>
        shown(hit)
          ? [
              {
                threadId: hit.threadId,
                threadTitle: hit.threadTitle,
                workspaceId: hit.workspaceId,
                provider: hit.provider,
                kind: hit.kind,
                createdAt: hit.createdAt,
                snippet: hit.snippet,
              },
            ]
          : [],
      );
    },
  });
}
