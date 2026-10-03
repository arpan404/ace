import { createFileRoute } from "@tanstack/react-router";
import { AdvancedSettings } from "@/features/settings/advanced-page.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

export const Route = createFileRoute("/settings/advanced")({
  component: () => (
    <SettingsBody page="Advanced">
      <AdvancedSettings />
    </SettingsBody>
  ),
});
