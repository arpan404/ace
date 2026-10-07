import { createFileRoute } from "@tanstack/react-router";
import { ProviderSettingsScreen } from "@/features/settings/index.ts";

/** Every coding agent on this computer, each opening its own page. */
export const Route = createFileRoute("/settings/providers/")({ component: ProviderSettingsScreen });
