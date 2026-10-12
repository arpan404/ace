import { createFileRoute } from "@tanstack/react-router";
import { StorageSettingsScreen } from "@/features/settings/index.ts";
export const Route = createFileRoute("/settings/storage")({ component: StorageSettingsScreen });
