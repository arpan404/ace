import { createFileRoute } from "@tanstack/react-router";
import { BetaSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/beta")({ component: BetaSettingsScreen });
