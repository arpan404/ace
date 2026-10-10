import { ChatsIcon, NotePencilIcon } from "@phosphor-icons/react";
import {
  useClient,
  useSidebar,
  useSidebarLoaded,
  useSidebarThread,
  useThreadMeta,
} from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { Link, useParams } from "@tanstack/react-router";
import { Suspense, useEffect, useRef } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useResolvedKeymap } from "@/lib/keybindings.ts";
import { formatKeys } from "@/lib/keymap.ts";
import { activityOf, isUnread } from "@ace/ui-core";
import { ThreadsActions } from "./project-filter.tsx";
import { ThreadList } from "./thread-list.tsx";
import { ThreadPagination } from "./thread-pagination.tsx";
import { useHomeList } from "./use-home-threads.ts";
import { rememberThread } from "./last-thread.ts";
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
  useSeenWhileOpen();
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
              title={project ? `Nothing in ${project}` : "No threads yet"}
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

/**
 * The open thread counts as read: tell the daemon once it has news, and again as it moves, so
 * every device sees it read. It is also the thread Home returns to.
 */
function useSeenWhileOpen() {
  const params = useParams({ strict: false });
  const threadId = params.threadId;
  const listed = useSidebarThread(threadId ?? "");
  const direct = useThreadMeta(threadId ?? "");
  const entry = listed ?? direct;
  const organizer = useOrganizer();
  const client = useClient();
  const { storage } = useLayout();
  const unread = entry ? isUnread(entry, organizer.getState().baseline) : false;
  const activity = entry ? activityOf(entry) : undefined;
  const sent = useRef<string>(undefined);
  useEffect(() => {
    if (threadId) rememberThread(storage, threadId);
  }, [storage, threadId]);
  useEffect(() => {
    if (!threadId || activity === undefined) return;
    // Once per thread and activity: marking the open thread unread by hand sticks until it
    // moves again or is opened anew.
    const key = `${threadId}@${activity}`;
    if (sent.current === key) return;
    sent.current = key;
    if (!unread) return;
    client
      .command({ type: "thread.read", threadId: ThreadId.parse(threadId), unread: false })
      .catch(() => {
        // Offline: try again when the list next changes.
        sent.current = undefined;
      });
  }, [client, threadId, unread, activity]);
}
