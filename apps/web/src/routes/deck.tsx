import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyPath } from "@/lib/legacy-paths.ts";

/** Deck's old addresses: Deck is called Offshift in the UI, at `/offshifts…`. */
export const Route = createFileRoute("/deck")({
  beforeLoad: ({ location }) => {
    throw redirect({
      href: `${legacyPath(location.pathname) ?? "/offshifts"}${location.searchStr}`,
      replace: true,
    });
  },
});
