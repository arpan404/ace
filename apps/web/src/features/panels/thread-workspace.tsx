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
import { defineTabKind, defineWorkspace, type TabKind } from "@/lib/workspace/index.ts";
import { ThreadDiffStat } from "./changes/diff-stat.tsx";

/*
 * A thread's workspace: the tools and resources that open beside its conversation. Each kind's
 * code loads the first time one of its tabs shows (ADR 0056); only the Changes badge renders
 * with the tab strip. To add a tool, define a kind (see apps/web/README.md, "Workspace tabs")
 * and list it in `threadKinds`.
 */

const views = () => import("./views.tsx");

export const changesKind = defineTabKind({
  kind: "changes",
  label: "Changes",
  icon: GitDiffIcon,
  singleton: true,
  pinned: true,
  shortcut: "changes",
  launcher: 10,
  Badge: (props) => <ThreadDiffStat threadId={props.scope} />,
  load: () => views().then((m) => ({ default: m.ChangesView })),
  // A file the agents edited opens where its diff is (a Files tool can claim this later).
  fromFile: (path) => ({ kind: "changes", data: { path } }),
});

export const terminalKind = defineTabKind({
  kind: "terminal",
  label: "Terminal",
  icon: TerminalWindowIcon,
  singleton: true,
  pinned: true,
  docks: ["bottom", "right"],
  shortcut: "terminal",
  launcher: 20,
  load: () => views().then((m) => ({ default: m.TerminalView, Actions: m.TerminalActions })),
});

export const filesKind = defineTabKind({
  kind: "files",
  label: "Files",
  icon: FilesIcon,
  singleton: true,
  shortcut: "files",
  launcher: 30,
  load: () => import("./placeholders.tsx").then((m) => ({ default: m.FilesPlaceholder })),
});

export const sideChatKind = defineTabKind({
  kind: "side-chat",
  label: "Side chat",
  icon: ChatsCircleIcon,
  singleton: true,
  shortcut: "sideChat",
  launcher: 40,
  load: () => import("./placeholders.tsx").then((m) => ({ default: m.SideChatPlaceholder })),
});

export const previewKind = defineTabKind({
  kind: "preview",
  label: "Preview",
  icon: BrowserIcon,
  singleton: true,
  shortcut: "preview",
  launcher: 50,
  load: () => views().then((m) => ({ default: m.PreviewView })),
  fromUrl: (url) => ({ kind: "preview", data: { url } }),
});

export const devicesKind = defineTabKind({
  kind: "devices",
  label: "Devices",
  icon: DeviceMobileIcon,
  singleton: true,
  shortcut: "devices",
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
  shortcut: "agents",
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
  shortcut: "logs",
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

/** A thread's docks: Changes and Agents beside it, Terminal and Logs below, all pinned. */
export const threadWorkspace = defineWorkspace({
  label: "Thread panel",
  kinds: threadKinds,
  launcher: launcherKind.kind,
  initial: [
    { kind: "changes", dock: "right", pinned: true },
    { kind: "agents", dock: "right", pinned: true },
    { kind: "terminal", dock: "bottom", pinned: true },
    { kind: "logs", dock: "bottom", pinned: true },
  ],
});
