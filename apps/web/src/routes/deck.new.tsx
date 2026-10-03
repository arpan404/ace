import { createFileRoute } from "@tanstack/react-router";
import { NewDeckForm } from "@/features/deck/new-deck-form.tsx";
import { Page, PageTitle, Screen } from "@/features/shell/screen.tsx";

/** ⌘⇧N: a goal and a few policies start a deck. */
export const Route = createFileRoute("/deck/new")({
  component: () => (
    <Screen title="New deck">
      <Page>
        <PageTitle
          title="New deck"
          lede="Describe the goal. The deck drafts a plan of cards, gives each card a worker and an adversarial reviewer, and merges what passes."
        />
        <NewDeckForm />
      </Page>
    </Screen>
  ),
});
