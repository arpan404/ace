import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HomeSidebar } from "@/features/home/home-sidebar.tsx";
import { ViewFrame } from "@/features/shell/view-frame.tsx";

/** Home view: the merged thread list beside the selected thread (or a new one). */
export const Route = createFileRoute("/_home")({
  component: () => (
    <ViewFrame label="Threads" sidebar={<HomeSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
