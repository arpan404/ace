import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DeckSidebar } from "@/features/deck/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/**
 * Offshifts: multi-agent runs. The UI calls them Offshifts; the code still says Deck (`features/deck`,
 * internally @ace/conductor) until the separate code rename lands.
 */
export const Route = createFileRoute("/offshifts")({
  component: () => (
    <ViewFrame label="Offshifts" sidebar={<DeckSidebar />} place="pane">
      <Outlet />
    </ViewFrame>
  ),
});
