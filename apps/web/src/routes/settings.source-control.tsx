import { createFileRoute } from "@tanstack/react-router";
import { SourceControlSettingsScreen } from "@/features/settings/index.ts";
export const Route = createFileRoute("/settings/source-control")({
  component: SourceControlSettingsScreen,
});
