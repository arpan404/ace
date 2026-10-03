import { createFileRoute } from "@tanstack/react-router";
import { DaemonSettings } from "@/features/settings/daemon-settings.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

/** TODO(settings slice): default provider, worktrees, auto-settle, login item. */
export const Route = createFileRoute("/settings/general")({
  component: () => (
    <SettingsBody page="General">
      <DaemonSettings />
    </SettingsBody>
  ),
});
