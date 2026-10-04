import { ChatsIcon } from "@phosphor-icons/react";
import { useClient, useSidebarLoaded, useSidebarThread } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useLayout } from "@/lib/layout.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { SidebarHeader } from "@/features/shell/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { activityOf, isUnread } from "@ace/ui-core";
import { ThreadsActions } from "./folder-rows.tsx";
import { ThreadList } from "./thread-list.tsx";
import { useHomeList } from "./use-home-threads.ts";
import { rememberThread } from "./last-thread.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";

/**
 * Home's list in the sidebar: pinned threads, then a folder per project with its threads in the
 * order of what is owed, with Settled folded away at the end. New thread sits above it.
 */
export function HomeSidebar() {
  const list = useHomeList();
  const { project } = useOrganizerState();
  const organizer = useOrganizer();
  useSeenWhileOpen();
  const loaded = useSidebarLoaded();
  const empty = !list.groups.pinned.length && !list.groups.projects.length && !list.settled.length;
  const directory = useProjectDirectory();
  const dialogs = useProjectDialogs();
  const noProjects = directory.loaded && directory.projects.length === 0;
  return (
    <>
      <SidebarHeader title="Threads" actions={<ThreadsActions />} />
      <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
        {!loaded ? (
          <ListSkeleton label="threads" shape="card" className="px-2" />
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
                    : "Start one with ⌘N. Threads from every project and machine land here."
              }
              action={
                !project && noProjects ? (
                  <button
                    type="button"
                    className="text-ui font-medium text-foreground underline-offset-4 hover:underline"
                    onClick={() => dialogs.open({ kind: "add", tab: "open" })}
                    onPointerEnter={dialogs.preload}
                  >
                    Add project…
                  </button>
                ) : project ? (
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
          <ThreadList list={list} />
        )}
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
  const entry = useSidebarThread(threadId ?? "");
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
