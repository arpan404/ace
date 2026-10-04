import {
  BrowserIcon,
  ChatsCircleIcon,
  DeviceMobileIcon,
  FilesIcon,
  GitDiffIcon,
  PlusIcon,
  ScrollIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { defineTabKind, type TabKind } from "@/lib/workspace/index.ts";
import { ThreadDiffStat } from "./changes/diff-stat.tsx";
import { QuickOpenOverlay } from "./files/quick-open-overlay.tsx";
import { quickOpen } from "./files/quick-open-store.ts";
import { fileTabId } from "./files/tab-id.ts";

/** The path a file tab shows, read defensively: tab data comes from storage. */
function tabPath(data: unknown): string | undefined {
  return typeof data === "object" &&
    data !== null &&
    "path" in data &&
    typeof data.path === "string"
    ? data.path
    : undefined;
}

/*
 * The thread workspace's tab kinds: the tools and resources that open beside a conversation.
 * This module loads after the thread screen's first paint (`thread-workspace.ts`), and each
 * kind's view loads the first time one of its tabs shows (ADR 0056). To add a tool, define a
 * kind here (see apps/web/README.md, "Workspace tabs"), list it in `threadKinds` and, if it has
 * a shortcut, add it to `thread-workspace.ts`.
 */

const views = () => import("./views.tsx");

export const changesKind = defineTabKind({
  kind: "changes",
  label: "Changes",
  icon: GitDiffIcon,
  singleton: true,
  pinned: true,
  launcher: 10,
  Badge: (props) => <ThreadDiffStat threadId={props.scope} />,
  load: () => views().then((m) => ({ default: m.ChangesView })),
});

export const terminalKind = defineTabKind({
  kind: "terminal",
  label: "Terminal",
  icon: TerminalWindowIcon,
  singleton: true,
  pinned: true,
  docks: ["bottom", "right"],
  launcher: 20,
  load: () => views().then((m) => ({ default: m.TerminalView, Actions: m.TerminalActions })),
});

/**
 * Files of the thread's checkout: one tab per file (the empty one is "Open file"), each with the
 * tree beside it. ⌘P opens the quick-open palette rather than toggling a tab.
 */
export const filesKind = defineTabKind({
  kind: "files",
  label: "Files",
  icon: FilesIcon,
  launcher: 30,
  title: (tab) => {
    const path = tabPath(tab.data);
    return path ? (path.split("/").at(-1) ?? path) : "Open file";
  },
  load: () => import("./files/file-tab.tsx"),
  fromFile: (path) => ({ kind: "files", id: fileTabId(path), data: { path } }),
  onShortcut: (scope) => quickOpen.set(() => scope),
  Overlay: QuickOpenOverlay,
});

export const sideChatKind = defineTabKind({
  kind: "side-chat",
  label: "Side chat",
  icon: ChatsCircleIcon,
  singleton: true,
  launcher: 40,
  load: () => import("./placeholders.tsx").then((m) => ({ default: m.SideChatPlaceholder })),
});

export const previewKind = defineTabKind({
  kind: "preview",
  label: "Preview",
  icon: BrowserIcon,
  singleton: true,
  launcher: 50,
  load: () => views().then((m) => ({ default: m.PreviewView })),
  fromUrl: (url) => ({ kind: "preview", data: { url } }),
});

export const devicesKind = defineTabKind({
  kind: "devices",
  label: "Devices",
  icon: DeviceMobileIcon,
  singleton: true,
  launcher: 60,
  // Its own chunk: the devices channel, frame decoding and screens load only when it shows.
  load: () => import("./devices-view.tsx").then((m) => ({ default: m.DevicesView })),
});

export const agentsKind = defineTabKind({
  kind: "agents",
  label: "Agents",
  icon: TreeStructureIcon,
  singleton: true,
  pinned: true,
  launcher: 70,
  load: () => views().then((m) => ({ default: m.AgentsView })),
});

export const logsKind = defineTabKind({
  kind: "logs",
  label: "Logs",
  icon: ScrollIcon,
  singleton: true,
  pinned: true,
  docks: ["bottom", "right"],
  launcher: 80,
  load: () => views().then((m) => ({ default: m.LogsView, Actions: m.LogsActions })),
});

/** The + button's new tab: a catalog of tools and what this thread suggests opening. */
export const launcherKind = defineTabKind({
  kind: "new-tab",
  label: "New tab",
  icon: PlusIcon,
  docks: ["right", "bottom"],
  load: () => import("./launcher/launcher-tab.tsx").then((m) => ({ default: m.LauncherTab })),
});

export const threadKinds: readonly TabKind[] = [
  changesKind,
  terminalKind,
  filesKind,
  sideChatKind,
  previewKind,
  devicesKind,
  agentsKind,
  logsKind,
  launcherKind,
];

export default threadKinds;
