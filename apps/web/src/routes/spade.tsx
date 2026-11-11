import { createFileRoute, redirect, Outlet } from "@tanstack/react-router";
import { SpadeSidebar } from "@/features/spade/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";
import { spadeAvailable } from "@/lib/spade-available.ts";

/** Spade's place: Spade and the bots in the sidebar beside the open conversation. */
export const Route = createFileRoute("/spade")({
  // A build without Spade has no Spade screens: its links lead home.
  beforeLoad: () => {
    if (!spadeAvailable) throw redirect({ to: "/" });
  },
  component: () => (
    <ViewFrame label="Spade" sidebar={<SpadeSidebar />} place="sidebar">
      <Outlet />
    </ViewFrame>
  ),
});
