import { createFileRoute } from "@tanstack/react-router";
import { RemoteSettingsScreen } from "@/features/settings/index.ts";

/** The fleet: every machine, how they work together, and the devices paired to them. */
export const Route = createFileRoute("/settings/remote/")({ component: RemoteSettingsScreen });
