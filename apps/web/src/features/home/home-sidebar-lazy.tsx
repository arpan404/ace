import { lazy, Suspense } from "react";

const HomeSidebar = lazy(() =>
  import("./home-sidebar.tsx").then((module) => ({ default: module.HomeSidebar })),
);

/**
 * The thread list for the app's one sidebar. It loads beside the first route (as Home's route
 * chunk used to carry it), so its rows, menus and dialogs stay out of the page's startup graph.
 */
export function ThreadsSidebar() {
  return (
    <aside aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
      <Suspense fallback={null}>
        <HomeSidebar />
      </Suspense>
    </aside>
  );
}
