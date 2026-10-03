import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HomeSidebar } from "@/features/home/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/** Home view: the merged thread list beside the selected thread (or a new one). */
export const Route = createFileRoute("/_home")({
  component: () => (
    <ViewFrame label="Threads" sidebar={<HomeSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
