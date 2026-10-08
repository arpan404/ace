import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/offshifts")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
