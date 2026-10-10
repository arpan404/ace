import { ChatsIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useSidebar, useSidebarLoaded } from "@ace/client-react";
import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useResolvedKeymap } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { ThreadsActions } from "./project-filter.tsx";
import { ThreadList } from "./thread-list.tsx";
import { ThreadPagination } from "./thread-pagination.tsx";
import { useHomeList } from "./use-home-threads.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";

/** Threads started here that the list doesn't show yet; its code loads after first paint. */
const DeferredStartedRows = deferredComponent(() =>
  import("./started-rows.tsx").then((module) => module.StartedRows),
);

/**
 * Home's list in the sidebar: one list of tasks across projects, pinned first, then in the order
 * of what is owed, with Settled folded away at the end. The toolbar pairs the project filter
 * with New thread, or offers Add project while there are none.
 */
export function HomeSidebar() {
  const list = useHomeList();
  const settledTotal = useSidebar(["homeWindow"], (reader) => reader.homeWindow?.total);
  const { project, settledOpen } = useOrganizerState();
  const organizer = useOrganizer();
  const loaded = useSidebarLoaded();
  const empty = [list.pinned, list.active, list.recent, list.settled].every((ids) => !ids.length);
  const directory = useProjectDirectory();
  const keys = useResolvedKeymap();
  const noProjects = directory.loaded && directory.projects.length === 0;
  return (
    <>
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-2">
        <ThreadsActions />
        {!noProjects && (
          <Tip label="New thread" shortcut="newThread">
            <Link
              to="/new"
              aria-label="New thread"
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground focus-ring touch-hit touch-hit-lg hover:bg-sidebar-accent hover:text-foreground"
            >
              <Icon icon={NotePencilIcon} />
            </Link>
          </Tip>
        )}
      </div>
      <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
        {loaded && (
          <Suspense fallback={null}>
            <DeferredStartedRows.Component />
          </Suspense>
        )}
        {!loaded ? (
          <ListSkeleton label="threads" shape="thread" className="px-2" />
        ) : empty ? (
          <>
            <EmptyState
              icon={ChatsIcon}
              title={project ? `Nothing in ${directory.name(project)}` : "No threads yet"}
              description={
                project
                  ? "Threads from this project will land here."
                  : noProjects
                    ? "Add a project first: a folder agents can work in."
                    : `Start one${keys.newThread ? ` with ${formatKeys(keys.newThread)}` : ""}. Threads from every project and machine land here.`
              }
              action={
                project ? (
                  <button
                    type="button"
                    className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => organizer.setProject(null)}
                  >
                    Show all projects
                  </button>
                ) : undefined
              }
            />
          </>
        ) : (
          <ThreadList list={list} settledTotal={settledTotal} />
        )}
        <ThreadPagination settledOpen={settledOpen} />
      </nav>
    </>
  );
}
