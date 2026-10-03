import { createFileRoute } from "@tanstack/react-router";
import { ProviderSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/providers")({ component: ProviderSettingsScreen });
