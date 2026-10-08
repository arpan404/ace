import { ThreadId, WorkspaceId, ItemId, type SearchQuery, type SearchResults } from "@ace/protocol";
import { searchThreads, type FakeSearchKind } from "../catalog/search.ts";

const week = 7 * 24 * 60 * 60_000;
const kinds = new Set<string>(["thread", "message", "tool_call", "artifact"]);
const isKind = (kind: string | undefined): kind is FakeSearchKind =>
  kind !== undefined && kinds.has(kind);

/** `search.query` over the catalog's corpus, in the daemon's result shape. */
export function search(query: SearchQuery, now: number): SearchResults {
  const kind = query.filters.kind;
  if (kind !== undefined && !isKind(kind)) return { hits: [], cursor: null, generation: 1 };
  // Test clocks start near the epoch; keep every hit's time after it, in the catalog's order.
  const hits = searchThreads(query.text, Math.max(now, week), { kind })
    .filter(
      (hit) =>
        (!query.filters.workspaceId || hit.workspaceId === query.filters.workspaceId) &&
        (!query.filters.provider || hit.provider === query.filters.provider) &&
        (!query.filters.kinds || query.filters.kinds.includes(hit.kind)) &&
        (query.filters.after === undefined || hit.createdAt >= query.filters.after) &&
        (query.filters.before === undefined || hit.createdAt <= query.filters.before),
    )
    .slice(0, query.limit);
  return {
    // These are new wire values, not copies of catalog rows.
    // oxlint-disable-next-line oxc/no-map-spread
    hits: hits.map((hit, index) => ({
      threadId: ThreadId.parse(hit.threadId),
      ...(hit.itemId ? { itemId: ItemId.parse(hit.itemId) } : {}),
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
