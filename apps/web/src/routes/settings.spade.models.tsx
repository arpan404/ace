import { createFileRoute } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";

/** Settings › Spade › Models: the person's endpoints, their keys and models. */
export const Route = createFileRoute("/settings/spade/models")({
  component: () => <SpadeSettingsScreen page="models" />,
});
