import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SpadeSidebar } from "@/features/spade/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/** Spade's place: its conversations in the sidebar beside the open one (or a new one). */
export const Route = createFileRoute("/spade")({
  component: () => (
    <ViewFrame label="Spade" sidebar={<SpadeSidebar />} place="sidebar">
      <Outlet />
    </ViewFrame>
  ),
});
