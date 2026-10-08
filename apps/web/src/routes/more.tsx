import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { legacyPath } from "@/lib/legacy-paths.ts";
import { useLayout } from "@/lib/layout.tsx";

/**
 * More's old pages: Usage & accounts is in the profile menu (`/accounts`), Files is a tab of each
 * thread's side panel, and search is a dialog. An old search address opens the dialog with its
 * words over Home.
 */
export const Route = createFileRoute("/more")({
  beforeLoad: ({ location }) => {
    if (location.pathname !== "/more/search")
      throw redirect({ to: legacyPath(location.pathname) ?? "/", replace: true });
  },
  component: LegacySearch,
});

function LegacySearch() {
  const query = Route.useSearch({
    select: (search: Record<string, unknown>) => (typeof search.q === "string" ? search.q : ""),
  });
  const { openSearch } = useLayout();
  // Opened as the redirect happens: a later visit to Home doesn't reopen it.
  useEffect(() => openSearch(query), [openSearch, query]);
  return <Navigate to="/" replace />;
}
