import { createFileRoute, Link } from "@tanstack/react-router";
import { CardsIcon } from "@phosphor-icons/react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

export const Route = createFileRoute("/deck/")({
  component: () => (
    <Screen title="Deck">
      <EmptyState
        icon={CardsIcon}
        title="Deal a goal to a team of agents"
        description="A deck plans the work as cards, gives each card a worker and a reviewer, and merges what passes."
        action={
          <Link to="/deck/new" className={buttonVariants({ variant: "primary" })}>
            New deck
          </Link>
        }
      />
    </Screen>
  ),
});
