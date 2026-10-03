import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SearchPage } from "@/features/search/index.ts";

const Search = z.object({
  q: z.string().max(512).optional().catch(undefined),
  kind: z.enum(["all", "message", "tool_call", "artifact", "thread"]).optional().catch(undefined),
});

/** Full-text search across every thread. */
export const Route = createFileRoute("/more/search")({
  validateSearch: (search) => Search.parse(search),
  component: SearchRoute,
});

function SearchRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SearchPage
      query={search.q ?? ""}
      kind={search.kind ?? "all"}
      // Typing replaces the entry; back returns to where search was opened from.
      onChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })
      }
    />
  );
}
