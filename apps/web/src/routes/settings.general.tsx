import { createFileRoute } from "@tanstack/react-router";
import { GeneralSettings } from "@/features/settings/general-page.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

export const Route = createFileRoute("/settings/general")({
  component: () => (
    <SettingsBody page="General">
      <GeneralSettings />
    </SettingsBody>
  ),
});
