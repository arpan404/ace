import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebarAll } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { arrange, isSettled, threadRowFlags, projectCounts, projectTint } from "@ace/ui-core";
import {
  useHomeSelection,
  useHomeSelectionState,
  useOrganizer,
  useOrganizerState,
  useThreadActions,
  useThreadMover,
  threadActions,
} from "@/features/organize/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import type { PaletteCommand, PaletteGroup } from "./types.ts";

const noEntries: ThreadListEntry[] = [];
const entriesOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [entry] : [];
  });

/**
 * Threads from every project in Home order (pinned first, settled last), each with its project's
 * name and branch, then the projects themselves by name, then actions on the threads picked in
 * Home and on the open thread. Mounted only while the palette is open, so the whole-list
 * subscription is short-lived.
 */
export function useThreadCommands(close: () => void): PaletteGroup[] {
  const navigate = useNavigate();
  const organizer = useOrganizer();
  const state = useOrganizerState();
  const actions = useThreadActions();
  const mover = useThreadMover();
  const now = useNow();
  const { screenActions } = useLayout();
  const current = useParams({ strict: false }).threadId;
  const selection = useHomeSelection();
  const picked = useHomeSelectionState().ids;
  const entries = useSidebarAll(entriesOf, arrayEqual) ?? noEntries;
  const projectName = useProjectName();

  return useMemo(() => {
    const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
    const order = arrange(entries, { ...state, project: null }, now);
    const run = (action: () => void) => () => {
      close();
      action();
    };
    const threads = [...order.pinned, ...order.active, ...order.recent, ...order.settled].flatMap(
      (id): PaletteCommand[] => {
        const entry = byId.get(id);
        if (!entry) return [];
        const branch = entry.details?.branch;
        return [
          {
            id: `thread-${id}`,
            label: entry.title,
            detail: projectName(entry.workspaceId),
            ...(branch ? { more: branch } : {}),
            icon: "thread",
            run: run(() => void navigate({ to: "/t/$threadId", params: { threadId: id } })),
          },
        ];
      },
    );
    const projects = projectCounts(entries).map((project): PaletteCommand => ({
      id: `project-${project.id}`,
      label: projectName(project.id),
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
            id: "selected-move",
            label: `Move ${n} to another project…`,
            icon: "action",
            run: run(() => mover.open({ entries: chosen, onMoved: () => selection.clear() })),
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
      const screen = screenActions?.scope === open.id ? screenActions : undefined;
      const list = threadActions(
        open,
        threadRowFlags(open, { baseline: state.baseline, now, settled: isSettled(open) }),
        actions,
        {
          onRename: () => screen?.rename(),
          fork: { point: undefined, onFork: () => screen?.fork?.() },
          onMove: () => mover.open({ entries: [open] }),
          onLeave: () => void navigate({ to: "/" }),
        },
      );
      groups.push({
        value: "This thread",
        items: [
          ...list
            .filter((action) => !action.disabled && (action.id !== "rename" || screen))
            .map((action): PaletteCommand => {
              const command: PaletteCommand = {
                id: `thread-${action.id}`,
                label: action.label,
                icon: action.icon,
                run: run(action.run),
              };
              if (action.shortcut) command.keys = keymap[action.shortcut].keys;
              if (action.danger) command.danger = true;
              return command;
            }),
          ...(screen
            ? [
                ...(screen.fork
                  ? [
                      {
                        id: "thread-fork",
                        label: "Fork from the last turn…",
                        icon: "action" as const,
                        run: run(screen.fork),
                      },
                    ]
                  : []),
                {
                  id: "thread-attachments",
                  label: "Attachments",
                  icon: "action" as const,
                  run: run(screen.attachments),
                },
                {
                  id: "thread-find",
                  label: "Search this thread",
                  keys: keymap.findInThread.keys,
                  icon: "action" as const,
                  run: run(screen.find),
                },
                {
                  id: "thread-turns",
                  label: "Turns",
                  keys: keymap.turns.keys,
                  icon: "action" as const,
                  run: run(screen.turns),
                },
              ]
            : []),
        ],
      });
    }
    return groups;
  }, [
    screenActions,
    entries,
    state,
    now,
    current,
    close,
    navigate,
    organizer,
    actions,
    mover,
    selection,
    picked,
    projectName,
  ]);
}
