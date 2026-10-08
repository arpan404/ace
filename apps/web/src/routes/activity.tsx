import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ActivityProvider, ActivitySidebar } from "@/features/activity/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/activity")({
  component: () => (
    <ActivityProvider>
      <ViewFrame label="Activity" sidebar={<ActivitySidebar />} place="pane">
        <Outlet />
      </ViewFrame>
    </ActivityProvider>
  ),
});
