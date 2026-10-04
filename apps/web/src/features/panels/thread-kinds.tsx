import {
  BrowserIcon,
  CardsIcon,
  ChatsCircleIcon,
  DeviceMobileIcon,
  FilesIcon,
  GitDiffIcon,
  PlusIcon,
  RobotIcon,
  ScrollIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { defineTabKind, type TabKind } from "@/lib/workspace/index.ts";
import { AgentBadge } from "./agents/agent-badge.tsx";
import { ThreadDiffStat } from "./changes/diff-stat.tsx";

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
  launcher: 20,
  load: () => views().then((m) => ({ default: m.TerminalView, Actions: m.TerminalActions })),
});

export const filesKind = defineTabKind({
  kind: "files",
  label: "Files",
  icon: FilesIcon,
  singleton: true,
  launcher: 30,
  load: () => import("./placeholders.tsx").then((m) => ({ default: m.FilesPlaceholder })),
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

/** One agent of the tree, opened from its row: its delegation, transcript and follow-up. */
export const agentKind = defineTabKind({
  kind: "agent",
  label: "Agent",
  icon: RobotIcon,
  Badge: AgentBadge,
  load: () => import("./agents/agent-tab.tsx").then((m) => ({ default: m.AgentTab })),
});

/** One lane of the deck a thread works for (id `run/card`); the whole deck stays in Deck. */
export const deckLaneKind = defineTabKind({
  kind: "deck-lane",
  label: "Deck lane",
  icon: CardsIcon,
  load: () => import("./deck-lane-view.tsx").then((m) => ({ default: m.DeckLaneView })),
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
  agentKind,
  deckLaneKind,
  launcherKind,
];

export default threadKinds;
