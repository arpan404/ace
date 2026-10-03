import { createFileRoute } from "@tanstack/react-router";
import { RemoteSettingsScreen } from "@/features/settings/index.ts";

export const Route = createFileRoute("/settings/remote")({ component: RemoteSettingsScreen });
