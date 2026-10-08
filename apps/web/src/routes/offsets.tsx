import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DeckSidebar } from "@/features/deck/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/**
 * Offsets: multi-agent runs. The UI calls them Offsets; the code still says Deck (`features/deck`,
 * internally @ace/conductor) until the separate code rename lands.
 */
export const Route = createFileRoute("/offsets")({
  component: () => (
    <ViewFrame label="Offsets" sidebar={<DeckSidebar />} place="pane">
      <Outlet />
    </ViewFrame>
  ),
});
