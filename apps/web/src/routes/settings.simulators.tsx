import { createFileRoute } from "@tanstack/react-router";
import { SimulatorsSettingsScreen } from "@/features/settings/index.ts";

/** This machine's simulators and emulators: on or off, and how Android emulators open. */
export const Route = createFileRoute("/settings/simulators")({
  component: SimulatorsSettingsScreen,
});
