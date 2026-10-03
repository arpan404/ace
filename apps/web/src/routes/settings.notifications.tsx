import { createFileRoute } from "@tanstack/react-router";
import { NotificationSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationSettingsScreen,
});
