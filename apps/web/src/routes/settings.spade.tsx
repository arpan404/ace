import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SpadeSettingsScreen } from "@/features/spade/index.ts";
import { useSpadeShown } from "@/lib/spade-available.ts";

export const Route = createFileRoute("/settings/spade")({ component: SpadeSettingsRoute });

function SpadeSettingsRoute() {
  // Hidden on this machine (ADR 0139): no Spade settings.
  const shown = useSpadeShown();
  if (shown === false) return <Navigate to="/settings" replace />;
  if (shown === undefined) return null;
  return <SpadeSettingsScreen />;
}
