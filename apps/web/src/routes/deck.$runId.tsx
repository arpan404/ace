import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { DeckRunPage } from "@/features/deck/index.ts";

const Search = z.object({
  tab: z.enum(["plan", "lanes", "log"]).optional().catch(undefined),
  card: z.string().max(128).optional().catch(undefined),
});

/** One deck: status line, gate, card graph and lane detail. */
export const Route = createFileRoute("/deck/$runId")({
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
      tab={search.tab ?? "plan"}
      card={search.card}
      onNavigate={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
    />
  );
}
