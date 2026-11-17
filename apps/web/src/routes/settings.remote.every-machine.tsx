import { createFileRoute } from "@tanstack/react-router";
import { FleetAcrossScreen } from "@/features/settings/index.ts";

/** How the machines work together, set on every connected machine at once. */
export const Route = createFileRoute("/settings/remote/every-machine")({
  component: FleetAcrossScreen,
});
