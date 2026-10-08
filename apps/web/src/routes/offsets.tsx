import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyPath } from "@/lib/legacy-paths.ts";

/** The short-lived `/offsets…` addresses: the feature is called Offshift, at `/offshifts…`. */
export const Route = createFileRoute("/offsets")({
  beforeLoad: ({ location }) => {
    throw redirect({
      href: `${legacyPath(location.pathname) ?? "/offshifts"}${location.searchStr}`,
      replace: true,
    });
  },
});
