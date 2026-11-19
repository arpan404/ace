import { createFileRoute } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";

/** Settings › Spade › Security: the sandbox here, and the network rule bots start with. */
export const Route = createFileRoute("/settings/spade/security")({
  component: () => <SpadeSettingsScreen page="security" />,
});
