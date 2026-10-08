import { landingDeck } from "@ace/ui-core";
import { CardsIcon } from "@phosphor-icons/react";
import { Link, Navigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Page, PageTitle, Screen, ViewListPage } from "@/features/shell/index.ts";
import { useDeckRetry, useDeckRuns } from "./deck-source.ts";
import { DeckSkeleton } from "./deck-run-page.tsx";
import { NewDeckForm } from "./new-deck-form.tsx";

/** Deck opens on the deck that most needs a look; with none, it invites the first. */
export function DeckLandingScreen() {
  const { ready, error, runs } = useDeckRuns();
  const retry = useDeckRetry();
  const first = landingDeck(runs);
  // A narrow window shows the list as the page; a wide one opens the run that needs a look.
  if (first)
    return (
      <ViewListPage
        title="Offshifts"
        fallback={<Navigate to="/offshifts/$runId" params={{ runId: first.id }} replace />}
      />
    );
  if (error && !runs.length)
    return (
      <Screen title="Offshifts">
        <EmptyState
          icon={CardsIcon}
          title="Offshifts unavailable"
          description="Couldn't reach the daemon's Offshifts service."
          action={
            <Button size="sm" onClick={retry}>
              Try again
            </Button>
          }
        />
      </Screen>
    );
  return (
    <Screen title="Offshifts">
      {!ready ? (
        <DeckSkeleton />
      ) : (
        <EmptyState
          icon={CardsIcon}
          heading
          title="Deal a goal to a team of agents"
          description="An offshift plans the work as cards, gives each card a worker and a reviewer, and merges what passes."
          action={
            <Link to="/offshifts/new" className={buttonVariants({ variant: "primary" })}>
              New offshift
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
    <Screen title="New offshift">
      <Page>
        <PageTitle
          title="New offshift"
          lede="Describe the goal. The offshift drafts a plan of cards, gives each card a worker and an adversarial reviewer, and merges what passes."
        />
        <NewDeckForm />
      </Page>
    </Screen>
  );
}
