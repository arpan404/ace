import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MoreSidebar } from "@/features/more/more-sidebar.tsx";
import { ViewFrame } from "@/features/shell/view-frame.tsx";

export const Route = createFileRoute("/more")({
  component: () => (
    <ViewFrame label="More" sidebar={<MoreSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
