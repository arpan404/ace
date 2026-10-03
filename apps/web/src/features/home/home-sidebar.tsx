import { ChatsIcon, MagnifyingGlassIcon, NotePencilIcon } from "@phosphor-icons/react";
import { useClient, useSidebarLoaded, useSidebarThread } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { SidebarHeader } from "@/features/shell/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { activityOf, isUnread } from "@ace/ui-core";
import { ProjectFilter } from "./project-filter.tsx";
import { ThreadList } from "./thread-list.tsx";
import { useHomeArrangement } from "./use-home-threads.ts";
import { rememberThread } from "./last-thread.ts";
import { useOrganizer, useOrganizerState } from "./use-organizer.ts";

/**
 * Home's second sidebar: New thread, search, and every thread from every project and machine
 * in one list ordered by what is owed, with Settled folded away at the end.
 */
export function HomeSidebar() {
  const arrangement = useHomeArrangement();
  const { project } = useOrganizerState();
  const organizer = useOrganizer();
  const { setPaletteOpen } = useLayout();
  useSeenWhileOpen();
  const loaded = useSidebarLoaded();
  const empty = !arrangement.active.length && !arrangement.settled.length;
  return (
    <>
      <SidebarHeader title="Threads" actions={<ProjectFilter />} />
      <Link
        to="/new"
        search={project ? { project } : {}}
        className="mx-2 mb-1.5 flex h-8 shrink-0 items-center gap-[9px] rounded-md px-2.5 text-ui font-medium text-sidebar-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent focus-visible:bg-sidebar-accent [&_svg]:text-muted-foreground"
      >
        <Icon icon={NotePencilIcon} />
        New thread
        <Kbd keys="mod+n" variant="bare" className="ml-auto" />
      </Link>
      <div className="shrink-0 pr-2.5 pb-2 pl-3">
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-[9px] bg-sidebar-accent pr-2 pl-2.5 text-ui text-subtle-foreground outline-none transition-[background-color,box-shadow] duration-(--dur-1) hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--foreground)_4%)] hover:shadow-[var(--glass-highlight)]"
        >
          <Icon icon={MagnifyingGlassIcon} />
          Search
          <Kbd keys="mod+k" variant="outline" className="ml-auto" />
        </button>
      </div>
      <nav aria-label="Threads" className="flex min-h-0 flex-1 flex-col">
        {!loaded ? (
          <ListSkeleton label="threads" shape="card" className="px-2" />
        ) : empty ? (
          <EmptyState
            icon={ChatsIcon}
            title={project ? `Nothing in ${project}` : "No threads yet"}
            description={
              project
                ? "Threads from this project will land here."
                : "Start one with ⌘N. Threads from every project and machine land here."
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
        ) : (
          <ThreadList arrangement={arrangement} />
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
