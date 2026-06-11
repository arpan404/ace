import { createFileRoute, redirect } from "@tanstack/react-router";

import { SettingsRouteLayout } from "../components/settings/SettingsRouteLayout";

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
