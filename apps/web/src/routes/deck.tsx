import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DeckSidebar } from "@/features/deck/deck-sidebar.tsx";
import { ViewFrame } from "@/features/shell/view-frame.tsx";

/** Deck: multi-agent runs (internally @ace/conductor). */
export const Route = createFileRoute("/deck")({
  component: () => (
    <ViewFrame label="Decks" sidebar={<DeckSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
