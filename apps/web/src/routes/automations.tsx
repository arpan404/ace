import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AutomationsSidebar } from "@/features/automations/index.ts";
import { SettingsNav } from "@/features/settings/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

/** Automations is a section of Settings' sidebar: its list sits under its link there. */
export const Route = createFileRoute("/automations")({
  component: () => (
    <ViewFrame
      label="Settings"
      sidebar={<SettingsNav section={{ to: "/automations", list: <AutomationsSidebar /> }} />}
      place="sidebar"
    >
      <Outlet />
    </ViewFrame>
  ),
});
