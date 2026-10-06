import { createFileRoute } from "@tanstack/react-router";
import { ComputerUseSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/computer-use")({
  component: ComputerUseSettingsScreen,
});
