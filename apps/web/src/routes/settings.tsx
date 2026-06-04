import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const LazySettingsRouteLayout = lazy(() =>
  import("../components/settings/SettingsRouteLayout").then((module) => ({
    default: module.SettingsRouteLayout,
  })),
);

function SettingsRouteLayout() {
  return (
    <Suspense fallback={null}>
      <LazySettingsRouteLayout />
    </Suspense>
  );
}

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
