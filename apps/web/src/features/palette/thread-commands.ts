import {
  ArchiveIcon,
  FolderOpenIcon,
  GitForkIcon,
  GitMergeIcon,
  ListNumbersIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PaperclipIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { SidebarReader } from "@ace/client";
import { arrayEqual, useSidebarAll } from "@ace/client-react";
import type { ThreadListEntry } from "@ace/protocol";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { arrange, isSettled, threadRowFlags, projectTint } from "@ace/ui-core";
import {
  useHomeSelection,
  useHomeSelectionState,
  useOrganizerState,
  useThreadActions,
  useThreadMover,
  threadActions,
} from "@/features/organize/index.ts";
import { useOpenProject } from "@/features/projects/index.ts";
import { focusComposerSoon } from "@/lib/focus-composer.ts";
import { useLayout } from "@/lib/layout.tsx";
import { keymap } from "@/lib/keymap.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useDebouncedValue, searchSettleMs } from "@/lib/debounced.ts";
import { useProjectDirectory, useProjectName } from "@/lib/projects.ts";
import { useNow } from "@/lib/time.ts";
import { useTransferOpener } from "@/lib/transfer-opener.ts";
import { useHasLinkedMachines } from "@/lib/fleet-links.ts";
import type { PaletteCommand, PaletteGroup } from "./types.ts";

const noEntries: ThreadListEntry[] = [];
const entriesOf = (reader: SidebarReader): ThreadListEntry[] =>
  reader.ids.flatMap((id) => {
    const entry = reader.thread(id);
    return entry ? [entry] : [];
  });

/**
 * Threads from every project in Home order (pinned first, settled last), each with its project's
 * name, branch and pull request; the projects themselves by name (each opens its latest thread)
 * and "New thread in" each of them; then actions on the threads picked in Home and on the open
 * thread. Mounted only while the palette is open, so the whole-list subscription is short-lived.
 */
export function useThreadCommands(close: () => void, query = ""): PaletteGroup[] {
  const navigate = useNavigate();
  const openProject = useOpenProject();
  const state = useOrganizerState();
  const actions = useThreadActions();
  const mover = useThreadMover();
  const transfers = useTransferOpener();
  const linked = useHasLinkedMachines();
  const now = useNow();
  const { screenActions } = useLayout();
  const current = useParams({ strict: false }).threadId;
  const selection = useHomeSelection();
  const picked = useHomeSelectionState().ids;
  const entries = useSidebarAll(entriesOf, arrayEqual) ?? noEntries;
  const projectName = useProjectName();
  const directory = useProjectDirectory();
  const settledQuery = useDebouncedValue(query.trim(), searchSettleMs);
  const found = useDaemonQuery({
    queryKey: ["palette-threads", settledQuery],
    read: async (client, signal) => {
      const reply = await client.request(
        { type: "search.query", scope: "threads", text: settledQuery, limit: 100 },
        { signal },
      );
      return reply.type === "search.results" ? reply.hits : [];
    },
  });

  return useMemo(() => {
    const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
    const order = arrange(entries, { ...state, project: null }, now);
    const run = (action: () => void) => () => {
      close();
      action();
    };
    // Into the thread with the caret in its message box, ready to type.
    const openThread = (threadId: string) => {
      void navigate({ to: "/t/$threadId", params: { threadId } });
      focusComposerSoon();
    };
    const threads = [
      ...order.pinned,
      ...order.active,
      ...order.recent,
      ...order.snoozed,
      ...order.settled,
    ].flatMap((id): PaletteCommand[] => {
      const entry = byId.get(id);
      if (!entry) return [];
      const branch = entry.details?.branch;
      const pr = entry.details?.linkedPrs?.[0]?.number ?? entry.details?.linkedPr?.number;
      return [
        {
          id: `thread-${id}`,
          label: entry.title,
          detail: projectName(entry.workspaceId),
          ...(branch ? { more: branch } : {}),
          ...(pr === undefined ? {} : { keywords: `#${pr} pr ${pr}` }),
          kind: "thread",
          threadId: id,
          at: entry.updatedAt,
          icon: "thread",
          run: run(() => openThread(id)),
        },
      ];
    });
    const seen = new Set(threads.map((thread) => thread.id));
    for (const hit of found.data ?? []) {
      const id = `thread-${hit.threadId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      threads.push({
        id,
        label: hit.threadTitle,
        detail: projectName(hit.workspaceId),
        kind: "thread",
        threadId: hit.threadId,
        at: hit.createdAt,
        icon: "thread",
        run: run(() => openThread(hit.threadId)),
      });
    }
    const projects = directory.projects.map((project): PaletteCommand => ({
      id: `project-${project.id}`,
      label: projectName(project.id),
      kind: "project",
      icon: "project",
      tint: projectTint(project.id),
      run: run(() => openProject(project.id)),
    }));
    const newIn = directory.projects.map((project): PaletteCommand => ({
      id: `new-in-${project.id}`,
      label: `New thread in ${projectName(project.id)}`,
      icon: NotePencilIcon,
      run: run(() => void navigate({ to: "/new", search: { project: project.id } })),
    }));
    const groups: PaletteGroup[] = [
      { value: "Threads", items: threads },
      { value: "Projects", items: projects },
      { value: "New thread", items: newIn },
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
            icon: unpin ? PushPinSlashIcon : PushPinIcon,
            run: run(() => {
              actions.setPinnedMany(chosen, !unpin);
              selection.clear();
            }),
          },
          {
            id: "selected-move",
            label: `Move ${n} to another project…`,
            icon: FolderOpenIcon,
            run: run(() => mover.open({ entries: chosen, onMoved: () => selection.clear() })),
          },
          {
            id: "selected-archive",
            label: `Archive ${n}`,
            icon: ArchiveIcon,
            run: run(() => {
              actions.archiveMany(chosen);
              selection.clear();
            }),
          },
          {
            id: "selected-delete",
            label: `Delete ${n}…`,
            icon: TrashIcon,
            danger: true,
            run: run(() => selection.ask("delete")),
          },
          {
            id: "selected-clear",
            label: "Clear the selection",
            icon: XIcon,
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
          ...(linked
            ? {
                onContinueOn: () =>
                  transfers.open({
                    kind: "thread",
                    threadId: open.id,
                    workspaceId: open.workspaceId,
                    title: open.title,
                  }),
              }
            : {}),
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
                        icon: GitForkIcon,
                        run: run(screen.fork),
                      },
                    ]
                  : []),
                ...(screen.merge
                  ? [
                      {
                        id: "thread-merge",
                        label: "Bring back to parent…",
                        icon: GitMergeIcon,
                        run: run(screen.merge),
                      },
                    ]
                  : []),
                {
                  id: "thread-attachments",
                  label: "Attachments",
                  icon: PaperclipIcon,
                  run: run(screen.attachments),
                },
                {
                  id: "thread-find",
                  label: "Search this thread",
                  keys: keymap.findInThread.keys,
                  icon: MagnifyingGlassIcon,
                  run: run(screen.find),
                },
                {
                  id: "thread-turns",
                  label: "Turns",
                  keys: keymap.turns.keys,
                  icon: ListNumbersIcon,
                  run: run(screen.turns),
                },
              ]
            : []),
        ],
      });
    }
    return groups;
  }, [
    linked,
    screenActions,
    entries,
    found.data,
    directory.projects,
    state,
    now,
    current,
    close,
    navigate,
    openProject,
    actions,
    mover,
    transfers,
    selection,
    picked,
    projectName,
  ]);
}
