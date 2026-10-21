import { createFileRoute } from "@tanstack/react-router";
import { OverviewSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/overview")({ component: OverviewSettingsScreen });
