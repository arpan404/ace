import { createFileRoute } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";

/** Settings › Spade › Web search: Brave or the person's own SearXNG. */
export const Route = createFileRoute("/settings/spade/search")({
  component: () => <SpadeSettingsScreen page="search" />,
});
