import { createFileRoute } from "@tanstack/react-router";
import { AgentsSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/agents")({ component: AgentsSettingsScreen });
