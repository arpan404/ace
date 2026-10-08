import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/offsets/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
