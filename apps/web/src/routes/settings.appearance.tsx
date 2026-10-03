import { createFileRoute } from "@tanstack/react-router";
import { AppearanceSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsScreen,
});
