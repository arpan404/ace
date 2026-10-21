import { createFileRoute } from "@tanstack/react-router";
import { SettingsIndexScreen } from "@/features/settings/index.ts";

/** On a narrow window the list of Settings pages; wider, Overview. */
export const Route = createFileRoute("/settings/")({ component: SettingsIndexScreen });
