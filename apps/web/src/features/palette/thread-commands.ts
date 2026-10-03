import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebar, useSidebarIds, type SidebarKey } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { arrange, isSettled, isUnread, projectCounts } from "@/features/home/arrange.ts";
import { threadDetailsSource } from "@/features/home/thread-details.ts";
import { useThreadActions } from "@/features/home/use-thread-actions.ts";
import { useOrganizer, useOrganizerState } from "@/features/home/use-organizer.ts";
import { useNow } from "@/lib/time.ts";
import type { PaletteCommand, PaletteGroup } from "./types.ts";

const none: readonly string[] = [];
const noEntries: ThreadListEntry[] = [];
const entriesOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [entry] : [];
  });

/**
 * Threads from every project in Home order (settled last), each with its project and branch,
 * then the projects themselves, then actions on the open thread. Mounted only while the
 * palette is open, so the whole-list subscription is short-lived.
 */
export function useThreadCommands(close: () => void): PaletteGroup[] {
  const navigate = useNavigate();
  const organizer = useOrganizer();
  const state = useOrganizerState();
  const actions = useThreadActions();
  const now = useNow();
  const current = useParams({ strict: false }).threadId;
  const ids = useSidebarIds() ?? none;
  const keys = useMemo<SidebarKey[]>(
    () => ["ids", ...ids.map((id): SidebarKey => `thread:${id}`)],
    [ids],
  );
  const entries = useSidebar(keys, entriesOf, arrayEqual) ?? noEntries;

  return useMemo(() => {
    const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
    const order = arrange(entries, { ...state, project: null }, now);
    const run = (action: () => void) => () => {
      close();
      action();
    };
    const threads = [...order.active, ...order.settled].flatMap((id): PaletteCommand[] => {
      const entry = byId.get(id);
      if (!entry) return [];
      const branch = threadDetailsSource.details(id)?.branch;
      return [
        {
          id: `thread-${id}`,
          label: state.marks[id]?.title ?? entry.title,
          detail: branch ? `${entry.workspaceId} · ${branch}` : entry.workspaceId,
          icon: "thread",
          run: run(() => void navigate({ to: "/t/$threadId", params: { threadId: id } })),
        },
      ];
    });
    const projects = projectCounts(entries, state).map((project): PaletteCommand => ({
      id: `project-${project.id}`,
      label: project.id,
      detail: `${project.threads} thread${project.threads === 1 ? "" : "s"}`,
      icon: "project",
      run: run(() => {
        organizer.setProject(project.id);
        void navigate({ to: "/" });
      }),
    }));
    const groups: PaletteGroup[] = [
      { value: "Threads", items: threads },
      { value: "Projects", items: projects },
    ];
    const open = current ? byId.get(current) : undefined;
    if (open) {
      const mark = state.marks[open.id];
      const settled = isSettled(open, mark, state.autoSettle, now);
      const unread = isUnread(open, mark, state.baseline);
      groups.push({
        value: "This thread",
        items: [
          {
            id: "thread-settle",
            label: settled ? "Unsettle this thread" : "Settle this thread",
            icon: "settle",
            run: run(() => (settled ? actions.unsettle(open) : actions.settle(open))),
          },
          {
            id: "thread-unread",
            label: unread ? "Mark this thread read" : "Mark this thread unread",
            icon: "action",
            run: run(() => actions.setUnread(open, !unread)),
          },
          {
            id: "thread-pin",
            label: mark?.pinned ? "Unpin this thread" : "Pin this thread",
            icon: "action",
            run: run(() => actions.setPinned(open, !mark?.pinned)),
          },
          {
            id: "thread-new-on-main",
            label: `New thread on main in ${open.workspaceId}`,
            icon: "action",
            run: run(() => actions.newThreadOnMain(open)),
          },
          {
            id: "thread-archive",
            label: "Archive this thread",
            icon: "action",
            run: run(() => {
              actions.archive(open);
              void navigate({ to: "/" });
            }),
          },
        ],
      });
    }
    return groups;
  }, [entries, state, now, current, close, navigate, organizer, actions]);
}
