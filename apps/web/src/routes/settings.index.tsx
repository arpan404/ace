import { createFileRoute } from "@tanstack/react-router";
import { SettingsIndexScreen } from "@/features/settings/index.ts";

/** On a phone the list of Settings pages; wider, General. */
export const Route = createFileRoute("/settings/")({ component: SettingsIndexScreen });
