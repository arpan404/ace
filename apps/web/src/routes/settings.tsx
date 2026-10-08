import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SettingsNav } from "@/features/settings/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/settings")({
  component: () => (
    <ViewFrame label="Settings" sidebar={<SettingsNav />} place="sidebar">
      <Outlet />
    </ViewFrame>
  ),
});
