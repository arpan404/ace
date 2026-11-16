import { createFileRoute } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";

/** Settings › Spade › General: running Spade, the models it starts bots on, and spending. */
export const Route = createFileRoute("/settings/spade/")({
  component: () => <SpadeSettingsScreen page="general" />,
});
