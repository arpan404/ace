import { z } from "zod";
import { AgentId, ItemId, ThreadId, Timestamp, WorkspaceId } from "./ids.ts";
import { ProviderKind } from "./provider.ts";

export const SearchKind = z.enum([
  "thread",
  "message",
  "reasoning",
  "tool_call",
  "notice",
  "compaction",
]);
export const SearchState = z.enum([
  "new",
  "working",
  "waiting",
  "needs_you",
  "done",
  "failed",
  "unresponsive",
]);
export const SearchFilters = z
  .object({
    workspaceId: WorkspaceId.optional(),
    provider: ProviderKind.optional(),
    after: Timestamp.optional(),
    before: Timestamp.optional(),
    status: SearchState.optional(),
    agentId: AgentId.optional(),
    kind: SearchKind.optional(),
  })
  .refine((f) => f.after === undefined || f.before === undefined || f.after <= f.before);
export const SearchQuery = z.object({
  text: z.string().max(512),
  mode: z.enum(["tokens", "substring"]).default("tokens"),
  scope: z.enum(["items", "threads"]).default("items"),
  filters: SearchFilters.default({}),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(2048).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;
export const SearchSnippet = z.object({
  text: z.string().max(4096),
  /** Half-open UTF-16 offsets within plain snippet text. */
  highlights: z
    .array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }))
    .max(256),
});
export const SearchHit = z.object({
  threadId: ThreadId,
  threadTitle: z.string().max(1024),
  itemId: ItemId.optional(),
  agentId: AgentId.optional(),
  workspaceId: WorkspaceId,
  provider: ProviderKind,
  status: SearchState,
  kind: SearchKind,
  createdAt: Timestamp,
  title: SearchSnippet,
  snippet: SearchSnippet,
  score: z.number().finite(),
});
export const SearchResults = z.object({
  hits: z.array(SearchHit).max(100),
  cursor: z.string().nullable(),
  generation: z.number().int().nonnegative(),
});
export type SearchResults = z.infer<typeof SearchResults>;
export const SearchStatus = z.object({
  indexedSeq: z.number().int().nonnegative(),
  headSeq: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  indexWrites: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  ready: z.boolean(),
});
export type SearchStatus = z.infer<typeof SearchStatus>;
const requestId = z.string().min(1).max(128);
export const SearchQueryRequest = SearchQuery.extend({
  type: z.literal("search.query"),
  requestId,
});
export const SearchStatusRequest = z.object({ type: z.literal("search.status"), requestId });
export const SearchQueryResponse = SearchResults.extend({
  type: z.literal("search.results"),
  requestId,
});
export const SearchStatusResponse = SearchStatus.extend({
  type: z.literal("search.progress"),
  requestId,
});
export const SearchErrorResponse = z.object({
  type: z.literal("search.error"),
  requestId,
  code: z.enum(["search_cursor_stale", "search_invalid_query", "search_failed"]),
});
