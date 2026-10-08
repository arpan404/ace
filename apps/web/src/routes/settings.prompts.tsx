import { createFileRoute } from "@tanstack/react-router";
import { PromptsSettingsScreen } from "@/features/settings/index.ts";
export const Route = createFileRoute("/settings/prompts")({ component: PromptsSettingsScreen });
