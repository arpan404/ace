import { fileTabData } from "./files/files-state.ts";
import {
  BrowserIcon,
  DeviceMobileIcon,
  FilesIcon,
  GitDiffIcon,
  GitPullRequestIcon,
  GlobeSimpleIcon,
  PlusIcon,
  ClipboardTextIcon,
} from "@phosphor-icons/react";
import { ComputerUseIcon } from "@/components/ace-icons.tsx";
import { ChangesSkeleton, FilesSkeleton } from "./tab-skeletons.tsx";
import { defineTabKind, PullRequestTabData, type TabKind } from "@/lib/workspace/index.ts";
import { addressHost } from "@ace/ui-core";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { LoadingBadge } from "./browser/loading-badge.tsx";
import { setLoading } from "./browser/loading.ts";
import { browserTabData, daemonTabId } from "./browser/browser-data.ts";
import { closeBrowserTab } from "./browser/browser-closers.ts";
import { BrowserTabBadge, BrowserTabMark } from "./browser/tab-mark.tsx";
import { BrowserTabMenuItems } from "./browser/tab-menu.tsx";
import { QuickOpenOverlay } from "./files/quick-open-overlay.tsx";
import { quickOpen } from "./files/quick-open-store.ts";
import { fileTabId } from "./files/tab-id.ts";
import { logsKind } from "./logs/logs-kind.tsx";
import { shellKind, terminalKind } from "./terminal/terminal-kinds.tsx";
import { visualizationKind } from "@/features/visualization/index.ts";

export { logsKind, shellKind, terminalKind };

/** A string field of a tab's data, read defensively: tab data comes from storage. */
function field(data: unknown, name: "path"): string | undefined {
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
  multiple: true,
  pinned: true,
  launcher: 10,
  Skeleton: ChangesSkeleton,
  load: () => views().then((m) => ({ default: m.ChangesView })),
});

/**
 * Files of the thread's checkout: the pinned Files tab (the tree, no file yet) and one tab per
 * file, each with the tree beside it. ⌘P opens the quick-open palette rather than toggling a tab.
 */
export const filesKind = defineTabKind({
  kind: "files",
  label: "Files",
  multiple: true,
  closeWarning: (_scope, tabs) =>
    tabs.some(({ tab }) => {
      const data = fileTabData(tab);
      return data.draft && data.draft.text !== data.draft.original;
    })
      ? {
          title: "Discard file edits?",
          description: "These tabs have unsaved file changes.",
          confirm: "Discard",
        }
      : undefined,
  icon: FilesIcon,
  launcher: 30,
  title: (tab) => {
    const path = field(tab.data, "path");
    return path ? (path.split("/").at(-1) ?? path) : "Files";
  },
  Skeleton: FilesSkeleton,
  load: () => import("./files/file-tab.tsx"),
  fromFile: (path) => ({ kind: "files", id: fileTabId(path), data: { path } }),
  onShortcut: (scope) => quickOpen.set(() => scope),
  Overlay: QuickOpenOverlay,
});

/**
 * The thread's browser: one panel tab per daemon browser tab (id: the daemon's tab id), the
 * person's and every agent's alike, the same on every device. The panel mirrors the daemon's
 * list (`browser/tab-sync.ts`): an agent's new tab joins the strip, a closed one leaves it.
 * A tab with no daemon tab yet (`browser`) is a new tab's start page; an address opened from
 * the launcher or a link starts as one and becomes the daemon tab it opens.
 */
export const browserKind = defineTabKind({
  kind: "browser",
  label: "Browser",
  icon: GlobeSimpleIcon,
  TabIcon: BrowserTabMark,
  Badge: BrowserTabBadge,
  MenuItems: BrowserTabMenuItems,
  launcher: 45,
  title: (tab) => {
    const data = browserTabData(tab);
    if (data.title) return data.title;
    const url = data.url ?? data.open;
    if (!url || url === "about:blank") return "New tab";
    return addressHost(url) ?? url;
  },
  load: () => import("./browser/browser-tab.tsx"),
  fromUrl: (url) => ({ kind: "browser", data: { open: url } }),
  // A closed daemon tab is gone for good; only a new tab's start page comes back.
  reopenable: (_scope, tab) => daemonTabId(tab) === undefined,
  onClose: (scope, tab) => {
    setLoading(scope, tab.key, false);
    const tabId = daemonTabId(tab);
    if (tabId) closeBrowserTab(scope, tabId);
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
  icon: ComputerUseIcon,
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

/** The thread's Summary: its plans, the whole agent tree, background commands and schedules. */
export const workKind = defineTabKind({
  kind: "work",
  label: "Summary",
  icon: ClipboardTextIcon,
  singleton: true,
  pinned: true,
  launcher: 0,
  load: () => import("./work/work-tab.tsx"),
});

/**
 * A pull request of the thread's project (id: project, repository and number), opened from the
 * thread's PR line or a PR it links to. Its view is the forge's, which the app provides.
 */
export const pullRequestKind = defineTabKind({
  kind: "pull-request",
  label: "Pull request",
  icon: GitPullRequestIcon,
  TabIcon: (props) => {
    const data = PullRequestTabData.safeParse(props.tab.data);
    const state = data.success && data.data.state !== "unknown" ? data.data.state : undefined;
    return (
      <span className={props.className}>
        <PullRequestGlyph state={state} size={14} />
      </span>
    );
  },
  title: (tab) => tab.title ?? "Pull request",
  load: () => import("./pull-request-view.tsx"),
});

/** The + button's new tab: a catalog of tools and what this thread suggests opening. */
export const launcherKind = defineTabKind({
  kind: "new-tab",
  label: "New tab",
  icon: PlusIcon,
  load: () => import("./launcher/launcher-tab.tsx").then((m) => ({ default: m.LauncherTab })),
});

export const threadKinds: readonly TabKind[] = [
  workKind,
  changesKind,
  terminalKind,
  filesKind,
  browserKind,
  previewKind,
  portKind,
  devicesKind,
  deviceKind,
  computerUseKind,
  logsKind,
  shellKind,
  pullRequestKind,
  visualizationKind,
  launcherKind,
];

export default threadKinds;
