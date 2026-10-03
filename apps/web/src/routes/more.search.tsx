import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { SearchPage } from "@/features/search/index.ts";

const Search = z.object({
  q: z.catch(z.optional(z.string().check(z.maxLength(512))), undefined),
  kind: z.catch(
    z.optional(z.enum(["all", "message", "tool_call", "artifact", "thread"])),
    undefined,
  ),
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
