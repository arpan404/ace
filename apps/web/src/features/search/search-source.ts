// TODO(train-2): wire to protocol when merged
/*
 * Full-text search across threads (#47: search.query → search.results). Hits keep the
 * protocol's SearchHit field names (threadId, threadTitle, workspaceId, provider, kind,
 * createdAt, snippet with UTF-16 highlights) so wiring it changes only this file.
 */
import type { ProviderKind } from "@ace/protocol";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { UnavailableError, useFakeBackend } from "@/features/more/fake-backend.ts";

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

export function useSearch(text: string, kind: SearchKind | undefined) {
  const backend = useFakeBackend();
  const query = text.trim();
  return useQuery({
    queryKey: ["search", query, kind ?? "all"],
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<SearchHit[]> => {
      if (!backend) throw new UnavailableError("Search");
      const fake = await backend;
      return fake.fake.searchThreads(query, fake.now(), { kind });
    },
  });
}
