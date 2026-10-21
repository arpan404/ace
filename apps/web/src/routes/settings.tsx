import { createFileRoute } from "@tanstack/react-router";
import { SettingsMachineProvider, SettingsNav, SettingsOutlet } from "@/features/settings/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";

export const Route = createFileRoute("/settings")({
  component: () => (
    <SettingsMachineProvider>
      <ViewFrame label="Settings" sidebar={<SettingsNav />} place="sidebar">
        <SettingsOutlet />
      </ViewFrame>
    </SettingsMachineProvider>
  ),
});
