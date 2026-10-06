import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebarAll } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { arrange, isSettled, isUnread, projectCounts, projectTint } from "@ace/ui-core";
import {
  useHomeSelection,
  useHomeSelectionState,
  useOrganizer,
  useOrganizerState,
  useThreadActions,
} from "@/features/organize/index.ts";
import { keymap } from "@/lib/keymap.ts";
import { useNow } from "@/lib/time.ts";
import type { PaletteCommand, PaletteGroup } from "./types.ts";

const noEntries: ThreadListEntry[] = [];
const entriesOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [entry] : [];
  });

/**
 * Threads from every project in Home order (pinned first, settled last), each with its project
 * and branch, then the projects themselves, then actions on the threads picked in Home and on
 * the open thread. Mounted only while the palette is open, so the whole-list subscription is
 * short-lived.
 */
export function useThreadCommands(close: () => void): PaletteGroup[] {
  const navigate = useNavigate();
  const organizer = useOrganizer();
  const state = useOrganizerState();
  const actions = useThreadActions();
  const now = useNow();
  const current = useParams({ strict: false }).threadId;
  const selection = useHomeSelection();
  const picked = useHomeSelectionState().ids;
  const entries = useSidebarAll(entriesOf, arrayEqual) ?? noEntries;

  return useMemo(() => {
    const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
    const order = arrange(entries, { ...state, project: null }, now);
    const run = (action: () => void) => () => {
      close();
      action();
    };
    const threads = [...order.pinned, ...order.active, ...order.settled].flatMap(
      (id): PaletteCommand[] => {
        const entry = byId.get(id);
        if (!entry) return [];
        const branch = entry.details?.branch;
        return [
          {
            id: `thread-${id}`,
            label: entry.title,
            detail: entry.workspaceId,
            ...(branch ? { more: branch } : {}),
            icon: "thread",
            run: run(() => void navigate({ to: "/t/$threadId", params: { threadId: id } })),
          },
        ];
      },
    );
    const projects = projectCounts(entries).map((project): PaletteCommand => ({
      id: `project-${project.id}`,
      label: project.id,
      detail: `${project.threads} thread${project.threads === 1 ? "" : "s"}`,
      icon: "project",
      tint: projectTint(project.id),
      run: run(() => {
        organizer.setProject(project.id);
        void navigate({ to: "/" });
      }),
    }));
    const groups: PaletteGroup[] = [
      { value: "Threads", items: threads },
      { value: "Projects", items: projects },
    ];
    const chosen = picked.flatMap((id) => byId.get(id) ?? []);
    if (chosen.length) {
      const n = chosen.length === 1 ? "1 selected thread" : `${chosen.length} selected threads`;
      const unpin = chosen.every((entry) => entry.pinned === true);
      groups.push({
        value: "Selected threads",
        items: [
          {
            id: "selected-pin",
            label: `${unpin ? "Unpin" : "Pin"} ${n}`,
            icon: "action",
            run: run(() => {
              actions.setPinnedMany(chosen, !unpin);
              selection.clear();
            }),
          },
          {
            id: "selected-archive",
            label: `Archive ${n}…`,
            icon: "action",
            run: run(() => selection.ask("archive")),
          },
          {
            id: "selected-delete",
            label: `Delete ${n}…`,
            icon: "action",
            danger: true,
            run: run(() => selection.ask("delete")),
          },
          {
            id: "selected-clear",
            label: "Clear the selection",
            icon: "action",
            run: run(() => selection.clear()),
          },
        ],
      });
    }
    const open = current ? byId.get(current) : undefined;
    if (open) {
      const settled = isSettled(open);
      const unread = isUnread(open, state.baseline);
      const pinned = open.pinned === true;
      groups.push({
        value: "This thread",
        items: [
          ...(settled || open.status.state === "done"
            ? [
                {
                  id: "thread-settle",
                  label: settled ? "Unsettle this thread" : "Settle this thread",
                  icon: "settle" as const,
                  run: run(() => (settled ? actions.unsettle(open) : actions.settle(open))),
                },
              ]
            : []),
          {
            id: "thread-unread",
            label: unread ? "Mark this thread read" : "Mark this thread unread",
            icon: "action",
            run: run(() => actions.setUnread(open, !unread)),
          },
          {
            id: "thread-pin",
            label: pinned ? "Unpin this thread" : "Pin this thread",
            keys: keymap.pinThread.keys,
            icon: "action",
            run: run(() => actions.setPinned(open, !pinned)),
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
  }, [entries, state, now, current, close, navigate, organizer, actions, selection, picked]);
}
