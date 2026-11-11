import { z } from "zod";
import { SearchQuery, SearchResults } from "@ace/protocol";
import { wireShape } from "@ace/provider-kit/wire-shape";

/**
 * The daemon's channel to its search worker. Both ends are this build (`searchWireShape`), so
 * messages are typed, not parsed: the query was validated where it entered the daemon, and
 * the results were built by `querySearch`, which validates them against `SearchResults`.
 * These schemas only define the message types and the channel's shape.
 */
const SearchWorkerRequest = z.object({
  id: z.number().int().positive(),
  query: SearchQuery,
});
const SearchWorkerResult = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), results: SearchResults }),
  z.object({
    id: z.number().int().positive(),
    ok: z.literal(false),
    error: z.enum(["search_cursor_stale", "search_invalid_query", "search_failed"]),
  }),
]);
export type SearchWorkerRequest = z.output<typeof SearchWorkerRequest>;
export type SearchWorkerResult = z.output<typeof SearchWorkerResult>;
export interface SearchWorkerData {
  path: string;
  shape: string;
}
export const searchWireShape = wireShape([SearchWorkerRequest, SearchWorkerResult]);
