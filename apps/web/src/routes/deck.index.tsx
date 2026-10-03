import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { CardsIcon } from "@phosphor-icons/react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { deckGroup } from "@ace/ui-core";
import { useDeckRuns } from "@/features/deck/deck-source.ts";
import { Screen } from "@/features/shell/screen.tsx";

/** Deck opens on the deck that most needs a look: gated first, then active, then the latest. */
export const Route = createFileRoute("/deck/")({ component: DeckIndex });

function DeckIndex() {
  const { ready, runs } = useDeckRuns();
  const first =
    runs.find((run) => deckGroup(run) === "gated") ??
    runs.find((run) => deckGroup(run) === "active") ??
    runs[0];
  if (first) return <Navigate to="/deck/$runId" params={{ runId: first.id }} replace />;
  return (
    <Screen title="Deck">
      {ready && (
        <EmptyState
          icon={CardsIcon}
          heading
          title="Deal a goal to a team of agents"
          description="A deck plans the work as cards, gives each card a worker and a reviewer, and merges what passes."
          action={
            <Link to="/deck/new" className={buttonVariants({ variant: "primary" })}>
              New deck
            </Link>
          }
        />
      )}
    </Screen>
  );
}
