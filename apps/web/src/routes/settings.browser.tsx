import { createFileRoute } from "@tanstack/react-router";
import { BrowserSettingsScreen } from "@/features/settings/index.ts";
export const Route = createFileRoute("/settings/browser")({ component: BrowserSettingsScreen });
