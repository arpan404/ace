import { z } from "zod";
import { SearchQuery, SearchResults } from "@ace/protocol";
export const SearchWorkerData = z.object({ path: z.string().min(1) });
export const SearchWorkerRequest = z.object({
  id: z.number().int().positive(),
  query: SearchQuery,
});
export const SearchWorkerResult = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), results: SearchResults }),
  z.object({
    id: z.number().int().positive(),
    ok: z.literal(false),
    error: z.enum(["search_cursor_stale", "search_invalid_query", "search_failed"]),
  }),
]);
