import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HomeSidebar } from "@/features/home/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/**
 * More's pages (usage and accounts, files, search), reached from the rail's ⋯ menu. They keep
 * the thread list in the one sidebar: More is a menu, never a second list of places.
 */
export const Route = createFileRoute("/more")({
  component: () => (
    <ViewFrame label="Threads" sidebar={<HomeSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
