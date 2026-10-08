/**
 * Addresses the app no longer serves, mapped to where their content lives now, so bookmarks,
 * notifications and old deep links still land somewhere. Deck is called Offset in the UI: its
 * routes moved from `/deck…` to `/offsets…`; More's pages moved to the profile menu (`/accounts`),
 * a thread's Files tab and the search dialog.
 */
export function legacyPath(pathname: string): string | undefined {
  if (pathname === "/deck" || pathname.startsWith("/deck/"))
    return `/offsets${pathname.slice("/deck".length)}`;
  if (pathname === "/more" || pathname === "/more/" || pathname.startsWith("/more/accounts"))
    return "/accounts";
  // Files live in each thread's side panel, search in a dialog over any screen.
  if (pathname.startsWith("/more/")) return "/";
  return undefined;
}
