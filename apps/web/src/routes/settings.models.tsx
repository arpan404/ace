import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/models")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/providers", replace: true });
  },
});
