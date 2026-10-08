import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/deck/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
