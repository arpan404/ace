import { createFileRoute } from "@tanstack/react-router";
import { ProfileSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/profile")({ component: ProfileSettingsScreen });
