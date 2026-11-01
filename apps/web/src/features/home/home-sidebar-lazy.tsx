import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useSidebarStore } from "@ace/client-react";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton.tsx";
import { Suspense } from "react";
import { useRailPlace } from "@/features/shell/index.ts";

const HomeSidebar = deferredComponent(() =>
  import("./home-sidebar.tsx").then((module) => module.HomeSidebar),
);
const ChatsSidebar = deferredComponent(() =>
  import("./chats-sidebar.tsx").then((module) => module.ChatsSidebar),
);

/**
 * The thread list for the app's one sidebar: the Threads panel, or the Chats panel while Chats is
 * the rail's place (a chat is open, or `/chats`). It loads beside the first route (as Home's
 * route chunk used to carry it), so its rows, menus and dialogs stay out of the page's startup
 * graph.
 */
export function ThreadsSidebar() {
  useSidebarStore();
  const chats = useRailPlace() === "chats";
  return (
    <aside aria-label={chats ? "Chats" : "Threads"} className="flex min-h-0 flex-1 flex-col">
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
            <ListSkeleton label="threads" shape="thread" />
          </>
        }
      >
        {chats ? <ChatsSidebar.Component /> : <HomeSidebar.Component />}
      </Suspense>
    </aside>
  );
}
