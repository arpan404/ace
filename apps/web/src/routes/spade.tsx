import { createFileRoute, Navigate, Outlet } from "@tanstack/react-router";
import { SpadeSidebar } from "@/features/spade/index.ts";
import { ViewFrame } from "@/features/shell/index.ts";
import { useSpadeShown } from "@/lib/spade-available.ts";

/** Spade's place: Spade and the bots in the sidebar beside the open conversation. */
export const Route = createFileRoute("/spade")({ component: SpadeRoute });

function SpadeRoute() {
  // Hidden on this machine (ADR 0139): Spade has no screens, and its links lead home.
  const shown = useSpadeShown();
  if (shown === false) return <Navigate to="/" replace />;
  if (shown === undefined) return null;
  return (
    <ViewFrame label="Spade" sidebar={<SpadeSidebar />} place="sidebar">
      <Outlet />
    </ViewFrame>
  );
}
