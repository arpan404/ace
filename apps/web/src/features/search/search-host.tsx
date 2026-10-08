import { lazy, Suspense, useState } from "react";
import { useLayout } from "@/lib/layout.tsx";

// The sheet, the search source and its results list load the first time search opens.
const SearchDialog = lazy(() => import("./search-dialog.tsx"));

/** The search dialog over any screen, while the layout says it is open (`openSearch`). */
export function SearchHost() {
  const { search, closeSearch } = useLayout();
  // Mounted once first opened, so its exit animation always has a dialog to play on.
  const [used, setUsed] = useState(false);
  if (search && !used) setUsed(true);
  if (!used) return null;
  return (
    <Suspense fallback={null}>
      <SearchDialog open={search !== undefined} query={search?.query ?? ""} onClose={closeSearch} />
    </Suspense>
  );
}
