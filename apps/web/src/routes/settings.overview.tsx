import { createFileRoute, redirect } from "@tanstack/react-router";

/** Overview was folded away: old links land on the first settings page. */
export const Route = createFileRoute("/settings/overview")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/agents", replace: true });
  },
});
