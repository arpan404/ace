import {
  activateTab,
  closeTab,
  openTab,
  shownTab,
  tabKey,
  updateTab,
  type ScopeWorkspace,
} from "@/lib/workspace/index.ts";
import { browserTabData, daemonTabId, newBrowserTab } from "./browser-data.ts";

/** The thread's browser as the daemon last reported it. */
export interface DaemonTabs {
  closed: boolean;
  tabs: readonly { tabId: string; url: string; title: string }[];
  activeTabId?: string | undefined;
}

export interface SyncMemory {
  /** The daemon's shown tab at the last sync; only a change moves the panel. */
  active: string | undefined;
  /** Tabs this window is closing: they never come back while the daemon still lists them. */
  closing: ReadonlySet<string>;
  /** A daemon state was synced before (this thread, this window). */
  seen: boolean;
  /**
   * Daemon tabs side by side in the panel's split view: the person showing one of them keeps
   * the panel on the split, whichever of the two it shows.
   */
  split?: readonly string[] | undefined;
}

/**
 * The panel's browser tabs, one per daemon tab, in step with the daemon (pure).
 *
 * - A daemon tab the panel lacks joins the end of the strip without being shown.
 * - A panel tab whose daemon tab is gone (or whose browser closed) leaves.
 * - Each tab keeps the page's address and title, for its strip title and the composer.
 * - When the daemon shows another tab (the person picked it on another device, or an agent's
 *   tab took the view under the 30-second rule) and the panel shows a browser tab, the panel
 *   follows (also when the tab it showed is the one that left); a panel showing another tool
 *   stays where it is.
 *
 * - When the thread's browser appears (the first state this window sees, or a browser opening
 *   where none showed), a shown, untouched new tab gives way to the tab the daemon shows: the
 *   Browser opened before the thread's browser was known, or an agent's page brought it forward.
 *
 * Unknown (no state yet, as after a daemon restart before the browser reopens) changes nothing.
 */
export function syncBrowserTabs(
  workspace: ScopeWorkspace,
  daemon: DaemonTabs | undefined,
  memory: SyncMemory,
): ScopeWorkspace {
  if (!daemon) return workspace;
  const listed = daemon.closed ? [] : daemon.tabs;
  // Whether the person looks at a browser tab, before any of them leaves.
  const showingBrowser = workspace.open && shownTab(workspace)?.kind === "browser";
  const ids = new Set(listed.map((tab) => tab.tabId));
  let next = workspace;
  for (const tab of workspace.tabs) {
    const id = daemonTabId(tab);
    if (id !== undefined && !ids.has(id)) next = closeTab(next, tab.key);
  }
  for (const tab of listed) {
    const key = tabKey("browser", tab.tabId);
    const present = next.tabs.find((each) => each.key === key);
    if (!present) {
      if (memory.closing.has(tab.tabId)) continue;
      next = openTab(
        next,
        { kind: "browser", id: tab.tabId, data: { url: tab.url, title: tab.title } },
        { reveal: false },
      );
      continue;
    }
    const data = browserTabData(present);
    if (data.url !== tab.url || data.title !== tab.title)
      next = updateTab(next, key, { data: { ...data, url: tab.url, title: tab.title } });
  }
  const shownId = daemon.closed ? undefined : daemon.activeTabId;
  const active = shownId !== undefined && ids.has(shownId) ? shownId : undefined;
  const shown = next.open ? shownTab(next) : undefined;
  if (
    active &&
    (!memory.seen || memory.active === undefined) &&
    shown?.kind === "browser" &&
    shown.id === newBrowserTab &&
    browserTabData(shown).open === undefined
  )
    return activateTab(closeTab(next, shown.key), tabKey("browser", active));
  const panelId = next.open ? shownTab(next)?.id : undefined;
  const together =
    !!memory.split && memory.split.includes(active ?? "") && memory.split.includes(panelId ?? "");
  if (active && active !== memory.active && next.open && showingBrowser && !together) {
    const key = tabKey("browser", active);
    if (next.active !== key) next = activateTab(next, key);
  }
  return next;
}
