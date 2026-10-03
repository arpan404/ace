import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SettingsNav } from "@/features/settings/settings-nav.tsx";
import { ViewFrame } from "@/features/shell/view-frame.tsx";

export const Route = createFileRoute("/settings")({
  component: () => (
    <ViewFrame label="Settings" sidebar={<SettingsNav />}>
      <Outlet />
    </ViewFrame>
  ),
});
