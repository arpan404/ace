import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/more/")({
  beforeLoad: () => {
    throw redirect({ to: "/more/accounts", replace: true });
  },
});
