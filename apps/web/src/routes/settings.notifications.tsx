import { createFileRoute } from "@tanstack/react-router";
import { BellIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { SettingsBody } from "@/features/settings/settings-body.tsx";

/** TODO(settings slice): needs-you, done, failures, mentions, quiet hours, sound. */
export const Route = createFileRoute("/settings/notifications")({
  component: () => (
    <SettingsBody page="Notifications">
      <EmptyState
        icon={BellIcon}
        title="Notification settings"
        description="Choose what reaches this machine and your paired phones."
        className="h-auto"
      />
    </SettingsBody>
  ),
});
