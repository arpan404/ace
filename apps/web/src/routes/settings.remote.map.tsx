import { createFileRoute } from "@tanstack/react-router";
import { FleetMapScreen } from "@/features/settings/index.ts";

/** The fleet as a network map: every machine and device and how each reaches this computer. */
export const Route = createFileRoute("/settings/remote/map")({ component: FleetMapScreen });
