import { createFileRoute } from "@tanstack/react-router";
import { AppearanceSettings } from "@/features/settings/appearance-page.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

export const Route = createFileRoute("/settings/appearance")({
  component: () => (
    <SettingsBody page="Appearance">
      <AppearanceSettings />
    </SettingsBody>
  ),
});
