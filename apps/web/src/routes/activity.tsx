import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ActivitySidebar } from "@/features/activity/activity-sidebar.tsx";
import { ViewFrame } from "@/features/shell/view-frame.tsx";

export const Route = createFileRoute("/activity")({
  component: () => (
    <ViewFrame label="Activity" sidebar={<ActivitySidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
