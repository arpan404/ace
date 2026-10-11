import { useSidebarStore } from "@ace/client-react";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton.tsx";
import { lazy, Suspense } from "react";

const HomeSidebar = lazy(() =>
  import("./home-sidebar.tsx").then((module) => ({ default: module.HomeSidebar })),
);

/**
 * The thread list for the app's one sidebar. It loads beside the first route (as Home's route
 * chunk used to carry it), so its rows, menus and dialogs stay out of the page's startup graph.
 */
export function ThreadsSidebar() {
  useSidebarStore();
  return (
    <aside aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
      <Suspense
        fallback={
          <>
            <div
              className="flex h-9 shrink-0 items-center justify-between px-2"
              aria-label="Loading thread controls"
            >
              <Skeleton className="h-3 w-24" />
              <Skeleton className="size-7" />
            </div>
            <ListSkeleton label="threads" shape="thread" className="px-2" />
          </>
        }
      >
        <HomeSidebar />
      </Suspense>
    </aside>
  );
}
