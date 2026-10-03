import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AutomationsSidebar } from "@/features/automations/automations-sidebar.tsx";
import { ViewFrame } from "@/features/shell/view-frame.tsx";

export const Route = createFileRoute("/automations")({
  component: () => (
    <ViewFrame label="Automations" sidebar={<AutomationsSidebar />}>
      <Outlet />
    </ViewFrame>
  ),
});
