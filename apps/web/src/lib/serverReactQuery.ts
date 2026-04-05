import type { ServerSearchOpenCodeModelsResult } from "@t3tools/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

const DEFAULT_OPENCODE_MODEL_PAGE_SIZE = 10;

export const serverQueryKeys = {
  searchOpenCodeModels: (query: string, limit: number) =>
    ["server", "opencode-models", query, limit] as const,
};

export function searchOpenCodeModelsInfiniteQueryOptions(input: {
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const query = input.query.trim();
  const limit = input.limit ?? DEFAULT_OPENCODE_MODEL_PAGE_SIZE;

  return infiniteQueryOptions<ServerSearchOpenCodeModelsResult>({
    queryKey: serverQueryKeys.searchOpenCodeModels(query, limit),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const api = ensureNativeApi();
      return api.server.searchOpenCodeModels({
        query,
        limit,
        offset: typeof pageParam === "number" ? pageParam : 0,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: input.enabled ?? true,
    staleTime: input.staleTime ?? 30_000,
  });
}
