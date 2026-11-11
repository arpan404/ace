import { createFileRoute, redirect } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";
import { spadeAvailable } from "@/lib/spade-available.ts";

export const Route = createFileRoute("/settings/spade")({
  // A build without Spade has no Spade settings.
  beforeLoad: () => {
    if (!spadeAvailable) throw redirect({ to: "/settings" });
  },
  component: SpadeSettingsScreen,
});
