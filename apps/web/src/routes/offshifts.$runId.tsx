import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { DeckRunPage } from "@/features/deck/index.ts";

const Search = z.object({
  tab: z.catch(z.optional(z.enum(["plan", "lanes"])), undefined),
  card: z.catch(z.optional(z.string().check(z.maxLength(128))), undefined),
});

/** One offshift: status line, gate, card graph and lane detail. */
export const Route = createFileRoute("/offshifts/$runId")({
  validateSearch: (search) => Search.parse(search),
  component: DeckRun,
});

function DeckRun() {
  const { runId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <DeckRunPage
      key={runId}
      runId={runId}
      tab={search.tab}
      card={search.card}
      onNavigate={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
    />
  );
}
