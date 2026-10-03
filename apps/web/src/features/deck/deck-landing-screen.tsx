import { landingDeck } from "@ace/ui-core";
import { CardsIcon } from "@phosphor-icons/react";
import { Link, Navigate } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Page, PageTitle, Screen } from "@/features/shell/index.ts";
import { useDeckRuns } from "./deck-source.ts";
import { NewDeckForm } from "./new-deck-form.tsx";

/** Deck opens on the deck that most needs a look; with none, it invites the first. */
export function DeckLandingScreen() {
  const { ready, runs } = useDeckRuns();
  const first = landingDeck(runs);
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

/** ⌘⇧N: a goal and a few policies start a deck. */
export function NewDeckScreen() {
  return (
    <Screen title="New deck">
      <Page>
        <PageTitle
          title="New deck"
          lede="Describe the goal. The deck drafts a plan of cards, gives each card a worker and an adversarial reviewer, and merges what passes."
        />
        <NewDeckForm />
      </Page>
    </Screen>
  );
}
