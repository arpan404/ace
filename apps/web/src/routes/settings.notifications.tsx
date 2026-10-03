import { createFileRoute } from "@tanstack/react-router";
import { NotificationSettings } from "@/features/settings/notifications-page.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

export const Route = createFileRoute("/settings/notifications")({
  component: () => (
    <SettingsBody page="Notifications">
      <NotificationSettings />
    </SettingsBody>
  ),
});
