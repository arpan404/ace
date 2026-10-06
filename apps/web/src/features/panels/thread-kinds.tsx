import {
  BrowserIcon,
  CardsIcon,
  ChatsCircleIcon,
  CursorClickIcon,
  DeviceMobileIcon,
  FilesIcon,
  GitDiffIcon,
  GlobeSimpleIcon,
  PlusIcon,
  RobotIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { ChangesSkeleton, FilesSkeleton } from "./tab-skeletons.tsx";
import { defineTabKind, type TabKind } from "@/lib/workspace/index.ts";
import { addressHost } from "@ace/ui-core";
import { LoadingBadge } from "./browser/loading-badge.tsx";
import { bindPage, nextBrowserId, pageOwners, setLoading } from "./browser/loading.ts";
import { AgentBadge, AgentTabIcon } from "./agents/agent-badge.tsx";
import { ThreadDiffStat } from "./changes/diff-stat.tsx";
import { QuickOpenOverlay } from "./files/quick-open-overlay.tsx";
import { quickOpen } from "./files/quick-open-store.ts";
import { fileTabId } from "./files/tab-id.ts";
import { logsKind } from "./logs/logs-kind.tsx";
import { shellKind, terminalKind } from "./terminal/terminal-kinds.tsx";

export { logsKind, shellKind, terminalKind };

/** A string field of a tab's data, read defensively: tab data comes from storage. */
function field(data: unknown, name: "path" | "url"): string | undefined {
  if (typeof data !== "object" || data === null || !(name in data)) return undefined;
  const value: unknown = Reflect.get(data, name);
  return typeof value === "string" ? value : undefined;
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
  Badge: (props) => <ThreadDiffStat threadId={props.scope} folded={props.folded} />,
  Skeleton: ChangesSkeleton,
  load: () => views().then((m) => ({ default: m.ChangesView })),
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
    const path = field(tab.data, "path");
    return path ? (path.split("/").at(-1) ?? path) : "Open file";
  },
  Skeleton: FilesSkeleton,
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
  // No daemon can run one yet: the protocol has no ephemeral, thread-scoped session.
  unavailable: "Not available yet",
  load: () => import("./placeholders.tsx").then((m) => ({ default: m.SideChatPlaceholder })),
});

/**
 * A page in the thread's browser: one tab per page, each with its own address and history over
 * the thread's single live page. Addresses from the launcher open here.
 */
export const browserKind = defineTabKind({
  kind: "browser",
  label: "Browser",
  icon: GlobeSimpleIcon,
  launcher: 45,
  title: (tab) => addressHost(field(tab.data, "url") ?? "") ?? "New page",
  Badge: LoadingBadge,
  load: () => import("./browser/browser-tab.tsx"),
  fromUrl: (url, workspace) => ({
    kind: "browser",
    id: nextBrowserId([...workspace.right.tabs, ...workspace.bottom.tabs].map((tab) => tab.key)),
    data: { url, go: true },
  }),
  onClose: (scope, tab) => {
    setLoading(scope, tab.key, false);
    // The page stays open for the thread's agents; it just has no tab driving it now.
    if (pageOwners.get().get(scope) === tab.key) bindPage(scope, undefined);
  },
});

export const previewKind = defineTabKind({
  kind: "preview",
  label: "Preview",
  icon: BrowserIcon,
  singleton: true,
  launcher: 50,
  Badge: LoadingBadge,
  load: () => views().then((m) => ({ default: m.PreviewView })),
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

/** Apps agents use on this Mac: live sessions, Take over, Delegate, Stop and this thread's grants. */
export const computerUseKind = defineTabKind({
  kind: "computer-use",
  label: "Computer use",
  icon: CursorClickIcon,
  singleton: true,
  launcher: 65,
  // Its own chunk: the screen channel, frame decoding and session cards load only when it shows.
  load: () => import("@/features/computer-use/index.ts").then((m) => m.loadComputerUsePanel()),
});

/** One dev server (id: its port), previewed edge to edge in its own tab. */
export const portKind = defineTabKind({
  kind: "port",
  label: "Preview",
  icon: BrowserIcon,
  Badge: LoadingBadge,
  load: () => import("./preview/port-tab.tsx").then((m) => ({ default: m.PortTab })),
});

/** One simulator or emulator (id: the device's), opened from the Devices catalog. */
export const deviceKind = defineTabKind({
  kind: "device",
  label: "Device",
  icon: DeviceMobileIcon,
  load: () => import("./devices-view.tsx").then((m) => ({ default: m.DeviceView })),
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

/** One agent of the tree, opened from its row: its delegation, transcript and follow-up. */
export const agentKind = defineTabKind({
  kind: "agent",
  label: "Agent",
  icon: RobotIcon,
  TabIcon: AgentTabIcon,
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
  browserKind,
  previewKind,
  portKind,
  devicesKind,
  deviceKind,
  computerUseKind,
  agentsKind,
  logsKind,
  agentKind,
  deckLaneKind,
  shellKind,
  launcherKind,
];

export default threadKinds;
