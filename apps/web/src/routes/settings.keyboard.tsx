import { createFileRoute } from "@tanstack/react-router";
import { KeyboardShortcuts } from "@/features/settings/keyboard-page.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

export const Route = createFileRoute("/settings/keyboard")({
  component: () => (
    <SettingsBody page="Keyboard">
      <KeyboardShortcuts />
    </SettingsBody>
  ),
});
