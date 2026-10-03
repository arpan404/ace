import { createFileRoute } from "@tanstack/react-router";
import { AdvancedSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/advanced")({ component: AdvancedSettingsScreen });
