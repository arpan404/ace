import {
  ArrowsInSimpleIcon,
  ArrowsOutSimpleIcon,
  FileIcon,
  FolderPlusIcon,
  GitBranchIcon,
  GitDiffIcon,
  GlobeIcon,
  NotePencilIcon,
  PlusSquareIcon,
  ScrollIcon,
  SidebarSimpleIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
  ArrowCounterClockwiseIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TerminalIcon,
  XSquareIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { openNewTerminal } from "@/features/panels/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { pageTitle, settingsIndex } from "@/features/settings/index.ts";
import { views, type View } from "@/features/shell/index.ts";
import { keymap } from "@/lib/keymap.ts";
import { useProjectDirectory } from "@/lib/projects.ts";
import {
  useFocusedScope,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceCommands,
} from "@/lib/workspace/index.ts";
import { useLayout } from "@/lib/layout.tsx";
import { themeIds, themes } from "@/theme/palettes.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { useThreadCommands } from "./thread-commands.ts";
import type { PaletteCommand, PaletteGroup } from "./types.ts";

export type { PaletteCommand, PaletteGroup, PaletteIcon } from "./types.ts";

type Destination = View["to"] | "/setup" | "/new" | "/accounts" | "/archived" | "/settings";

/** The order groups show in with an empty query: what's at hand first, the long lists after. */
const groupOrder = [
  "Selected threads",
  "This thread",
  "Create",
  "Go to",
  "Threads",
  "Projects",
  "Actions",
  "Theme",
  "Settings",
] as const;
const orderOf = (group: PaletteGroup) => {
  const index = groupOrder.indexOf(group.value as (typeof groupOrder)[number]);
  return index === -1 ? groupOrder.length : index;
};

/** The side panel's own tab commands, each with a glyph that says what it does. */
function tabCommandIcon(id: string, label: string): PaletteCommand["icon"] {
  if (id === "tab-pin") return label.startsWith("Unpin") ? PushPinSlashIcon : PushPinIcon;
  if (id === "tab-close-others") return XSquareIcon;
  if (id === "tab-reopen") return ArrowCounterClockwiseIcon;
  return "action";
}

/**
 * Every ⌘K group, in the order an empty query shows them. Commands are plain data, so features
 * register entries without touching the dialog: threads, projects and thread actions come from
 * `thread-commands.ts`.
 */
export function usePaletteGroups(close: () => void, query = ""): PaletteGroup[] {
  const navigate = useNavigate();
  const { resolved, update } = useTheme();
  // Workspace commands act on the screen showing one (a thread), and only appear there.
  const scope = useFocusedScope();
  const workspace = useScopeWorkspace(scope);
  const panel = useWorkspaceActions(scope ?? "");
  // The showing tab's commands (pin, close others, reopen): PN-05, PN-19.
  const tabCommands = useWorkspaceCommands();
  const threadGroups = useThreadCommands(close, query);
  const projects = useProjectDialogs();
  const directory = useProjectDirectory();
  const { openSearch } = useLayout();
  // With no project yet, adding one is the only way forward.
  const noProjects = directory.loaded && directory.projects.length === 0;
  const staticGroups = useMemo(() => {
    const run = (action: () => void) => () => {
      close();
      action();
    };
    const go = (to: Destination) => run(() => void navigate({ to }));
    const needsProject = noProjects ? { disabled: "Add a project first" } : {};
    const addProject: PaletteCommand = {
      id: "add-project",
      label: "Add project…",
      keys: keymap.addProject.keys,
      icon: FolderPlusIcon,
      run: run(() => projects.open({ kind: "add", tab: "sources" })),
    };
    const create: PaletteCommand[] = [
      {
        id: "new-thread",
        label: "New thread",
        keys: keymap.newThread.keys,
        icon: NotePencilIcon,
        ...needsProject,
        run: go("/new"),
      },
    ];
    const groups: PaletteGroup[] = [
      {
        value: "Create",
        items: [
          ...(noProjects ? [addProject, ...create] : [...create, addProject]),
          {
            id: "clone-repository",
            label: "Clone a repository…",
            icon: GitBranchIcon,
            run: run(() => projects.open({ kind: "add", tab: "clone" })),
          },
        ],
      },
      {
        value: "Go to",
        items: [
          ...views.map((view): PaletteCommand => {
            const command: PaletteCommand = {
              id: `go-${view.id}`,
              label: view.label,
              icon: "view",
              run: go(view.to),
            };
            if (view.shortcut) command.keys = keymap[view.shortcut].keys;
            return command;
          }),
          {
            id: "go-search",
            label: "Search all threads",
            keys: keymap.search.keys,
            icon: "view",
            run: run(() => openSearch()),
          },
          { id: "go-setup", label: "Setup", icon: "view", run: go("/setup") },
          { id: "go-accounts", label: "Usage", icon: "view", run: go("/accounts") },
          { id: "go-archived", label: "Archived threads", icon: "view", run: go("/archived") },
          {
            id: "go-settings",
            label: "Settings",
            keys: keymap.settings.keys,
            icon: "view",
            run: go("/settings"),
          },
        ],
      },
      {
        value: "Actions",
        items: scope
          ? [
              {
                id: "toggle-changes",
                label: "Show changes",
                keys: keymap.changes.keys,
                icon: GitDiffIcon,
                run: run(() => panel.toggleKind("changes")),
              } satisfies PaletteCommand,
              {
                id: "open-agents",
                label: "Open agent tree",
                keys: keymap.agents.keys,
                icon: TreeStructureIcon,
                run: run(() => panel.toggleKind("work")),
              } satisfies PaletteCommand,
              {
                id: "open-terminal",
                label: "Open terminal",
                keys: keymap.terminal.keys,
                icon: TerminalWindowIcon,
                run: run(() => panel.toggleKind("terminal")),
              } satisfies PaletteCommand,
              {
                id: "open-file",
                label: "Open a file from the checkout",
                keys: keymap.files.keys,
                icon: FileIcon,
                run: run(() => panel.shortcut("files")),
              } satisfies PaletteCommand,
              {
                id: "open-browser",
                label: "Open the browser",
                keys: keymap.browser.keys,
                icon: GlobeIcon,
                run: run(() => panel.shortcut("browser")),
              } satisfies PaletteCommand,
              {
                id: "new-terminal",
                label: "New terminal",
                keys: keymap.newTerminal.keys,
                icon: TerminalIcon,
                run: run(() => openNewTerminal(panel, workspace)),
              } satisfies PaletteCommand,
              {
                id: "open-logs",
                label: "Show logs",
                keys: keymap.logs.keys,
                icon: ScrollIcon,
                run: run(() => panel.toggleKind("logs")),
              } satisfies PaletteCommand,
              {
                id: "toggle-right",
                label: `${workspace.open ? "Hide" : "Show"} side panel`,
                keys: keymap.rightPanel.keys,
                icon: SidebarSimpleIcon,
                run: run(() => panel.toggle()),
              } satisfies PaletteCommand,
              {
                id: "new-tab",
                label: "New tab in the side panel",
                keys: keymap.newTab.keys,
                icon: PlusSquareIcon,
                run: run(() => panel.newTab()),
              } satisfies PaletteCommand,
              {
                id: "full-view",
                label: workspace.expanded ? "Exit full view" : "Side panel in full view",
                keys: keymap.fullView.keys,
                icon: workspace.expanded ? ArrowsInSimpleIcon : ArrowsOutSimpleIcon,
                run: run(() => panel.setExpanded(!workspace.expanded)),
              } satisfies PaletteCommand,
              ...tabCommands.map((command): PaletteCommand => ({
                ...command,
                id: `workspace-${command.id}`,
                icon: tabCommandIcon(command.id, command.label),
                run: run(command.run),
              })),
            ]
          : [],
      },
      {
        value: "Theme",
        items: [
          {
            id: "theme-toggle",
            label: "Toggle light and dark",
            icon: "theme",
            run: run(() => update({ mode: resolved.scheme === "dark" ? "light" : "dark" })),
          },
          {
            id: "theme-system",
            label: "Match system light and dark",
            icon: "theme",
            run: run(() => update({ mode: "system" })),
          },
          ...themeIds.map((id): PaletteCommand => ({
            id: `theme-${id}`,
            label: `Use ${themes[id].name}`,
            icon: "theme",
            run: run(() => update({ theme: id })),
          })),
        ],
      },
    ];
    // Single settings, from Settings' own index (rows read their titles from it). They only
    // show for a query: "accent" opens Appearance at the Accent row.
    groups.push({
      value: "Settings",
      items: settingsIndex.map((entry): PaletteCommand => ({
        id: `setting-${entry.id}`,
        label: entry.title,
        detail: pageTitle(entry.page),
        icon: "view",
        run: run(() => void navigate({ to: entry.page, hash: entry.id })),
      })),
    });
    return groups;
  }, [
    close,
    navigate,
    resolved.scheme,
    update,
    scope,
    panel,
    workspace,
    tabCommands,
    projects,
    noProjects,
    openSearch,
  ]);
  return useMemo(
    () =>
      [...threadGroups, ...staticGroups]
        .filter((group) => group.items.length > 0)
        .toSorted((a, b) => orderOf(a) - orderOf(b)),
    [threadGroups, staticGroups],
  );
}
