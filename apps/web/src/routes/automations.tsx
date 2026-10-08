import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AutomationsSidebar } from "@/features/automations/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/automations")({
  component: () => (
    <ViewFrame label="Automations" sidebar={<AutomationsSidebar />} place="pane">
      <Outlet />
    </ViewFrame>
  ),
});
