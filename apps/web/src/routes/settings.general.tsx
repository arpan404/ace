import { createFileRoute } from "@tanstack/react-router";
import { GeneralSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/general")({ component: GeneralSettingsScreen });
