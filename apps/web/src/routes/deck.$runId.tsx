import { createFileRoute } from "@tanstack/react-router";
import { CardsIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

/** One deck. TODO(deck slice): status line, gate, card graph and lane detail. */
export const Route = createFileRoute("/deck/$runId")({ component: DeckRun });

function DeckRun() {
  const { runId } = Route.useParams();
  return (
    <Screen title="Deck" subtitle={runId}>
      <EmptyState
        icon={CardsIcon}
        title="Loading deck"
        description="The plan and its cards appear here."
      />
    </Screen>
  );
}
