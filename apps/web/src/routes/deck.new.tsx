import { createFileRoute } from "@tanstack/react-router";
import { CardsIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

/** ⌘⇧N. TODO(deck slice): goal form that starts a run. */
export const Route = createFileRoute("/deck/new")({
  component: () => (
    <Screen title="New deck">
      <EmptyState
        icon={CardsIcon}
        title="Describe the goal"
        description="The deck drafts a plan of cards for you to approve before any agent starts."
      />
    </Screen>
  ),
});
