import { createFileRoute } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";

/** Settings › Spade › Apps: connected apps, plugins and skills, and which bots use each. */
export const Route = createFileRoute("/settings/spade/apps")({
  component: () => <SpadeSettingsScreen page="apps" />,
});
