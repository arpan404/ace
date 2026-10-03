import { ThreadId, WorkspaceId, type SearchQuery, type SearchResults } from "@ace/protocol";
import { searchThreads, type FakeSearchKind } from "../catalog/search.ts";

const kinds = new Set<string>(["thread", "message", "tool_call", "artifact"]);
const isKind = (kind: string | undefined): kind is FakeSearchKind =>
  kind !== undefined && kinds.has(kind);

/** `search.query` over the catalog's corpus, in the daemon's result shape. */
export function search(query: SearchQuery, now: number): SearchResults {
  const kind = query.filters.kind;
  if (kind !== undefined && !isKind(kind)) return { hits: [], cursor: null, generation: 1 };
  const hits = searchThreads(query.text, now, { kind })
    .filter(
      (hit) =>
        (!query.filters.workspaceId || hit.workspaceId === query.filters.workspaceId) &&
        (!query.filters.provider || hit.provider === query.filters.provider),
    )
    .slice(0, query.limit);
  return {
    hits: hits.map((hit, index) => ({
      threadId: ThreadId.parse(hit.threadId),
      threadTitle: hit.threadTitle,
      workspaceId: WorkspaceId.parse(hit.workspaceId),
      provider: hit.provider,
      status: "done",
      statusSeq: 0,
      kind: hit.kind,
      createdAt: hit.createdAt,
      title: { text: hit.threadTitle, highlights: [] },
      snippet: hit.snippet,
      score: hits.length - index,
    })),
    cursor: null,
    generation: 1,
  };
}
