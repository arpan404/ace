import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DeckSidebar } from "@/features/deck/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/** Deck: multi-agent runs (internally @ace/conductor). */
export const Route = createFileRoute("/deck")({
  component: () => (
    <ViewFrame label="Decks" sidebar={<DeckSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
