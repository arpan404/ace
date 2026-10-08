import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyPath } from "@/lib/legacy-paths.ts";

/** Deck's old addresses: Deck is called Offset in the UI, at `/offsets…`. */
export const Route = createFileRoute("/deck")({
  beforeLoad: ({ location }) => {
    throw redirect({
      href: `${legacyPath(location.pathname) ?? "/offsets"}${location.searchStr}`,
      replace: true,
    });
  },
});
