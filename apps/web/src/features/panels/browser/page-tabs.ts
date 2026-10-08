import { samePage } from "@ace/ui-core";
import type { BrowserView } from "../sources.ts";

/*
 * One page per browser tab. The daemon keeps one browser session per thread with up to eight
 * pages (its "tabs"), one of them active: the one its frames, its native view and an agent's
 * commands follow. In the side panel each of those pages is a browser tab of its own. This
 * module decides, from the panel's browser tabs and the daemon's pages, which tab shows which
 * page, which pages need a tab, and which tab should follow the live page. No I/O.
 */

/** A daemon page as the panel sees it. */
export interface LivePage {
  tabId: string;
  url: string;
  title: string;
}

/** A browser tab of the panel, by what it keeps. */
export interface PanelPage {
  key: string;
  /** The daemon page it shows, once it has one. */
  page?: string | undefined;
  /** Its own address (where it is, or last was). */
  url?: string | undefined;
  /** Opened for a page by this sync (not by the person): yields to the person's own tab. */
  spawned?: boolean | undefined;
}

/** The daemon's pages, the active one first in importance. A session without a list has one. */
export function livePages(view: BrowserView | undefined): {
  pages: readonly LivePage[];
  active: string | undefined;
} {
  if (!view || view.closed) return { pages: [], active: undefined };
  if (view.tabs?.length)
    return {
      pages: view.tabs.map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title })),
      active: view.activeTabId ?? view.tabs[0]?.tabId,
    };
  const only = view.activeTabId ?? "page";
  return { pages: [{ tabId: only, url: view.url, title: "" }], active: only };
}

export interface PagePlan {
  /** Tabs that take a page they didn't have (panel key → daemon page). */
  claims: ReadonlyMap<string, string>;
  /** Pages no tab shows: each opens as a tab of its own. */
  opens: readonly LivePage[];
  /** Tabs whose page closed: they keep their address and offer to open it again. */
  stale: readonly string[];
  /** Tabs showing a page another tab shows (a race while a page opens): they go. */
  duplicates: readonly string[];
}

/**
 * Which tab shows which page. A tab keeps the page it has while the daemon still has it (the
 * person's own tab first, if two show one). A page without a tab goes, in order, to the tab
 * opening one right now (`opening`), to a tab that has
 * none and is on the same address (or on none, for the active page: a fresh Browser tab shows
 * what the agent is doing), and otherwise opens a tab of its own. Pages the person closed the
 * tab of (`dismissed`) stay without one.
 */
export function planPages(input: {
  panels: readonly PanelPage[];
  pages: readonly LivePage[];
  active: string | undefined;
  opening?: string | undefined;
  dismissed?: ReadonlySet<string> | undefined;
}): PagePlan {
  const live = new Set(input.pages.map((page) => page.tabId));
  const shown = new Set<string>();
  const stale: string[] = [];
  const duplicates: string[] = [];
  // The person's own tabs keep a page before the ones opened for it.
  const ranked = input.panels.toSorted((a, b) => Number(a.spawned) - Number(b.spawned));
  for (const panel of ranked) {
    if (panel.page === undefined) continue;
    if (!live.has(panel.page)) stale.push(panel.key);
    else if (shown.has(panel.page)) duplicates.push(panel.key);
    else shown.add(panel.page);
  }
  const free = input.panels.filter(
    (panel) => panel.page === undefined || stale.includes(panel.key),
  );
  const claims = new Map<string, string>();
  const take = (page: LivePage, panel: PanelPage | undefined) => {
    if (!panel) return false;
    claims.set(panel.key, page.tabId);
    free.splice(free.indexOf(panel), 1);
    return true;
  };
  const opens: LivePage[] = [];
  // The active page first: it is the one a tab being opened or a fresh tab is waiting for.
  const ordered = input.pages.toSorted(
    (a, b) => Number(b.tabId === input.active) - Number(a.tabId === input.active),
  );
  for (const page of ordered) {
    if (shown.has(page.tabId) || input.dismissed?.has(page.tabId)) continue;
    const active = page.tabId === input.active;
    // The tab that asked for a page takes the first new one, active yet or not.
    const opening = free.find((panel) => panel.key === input.opening);
    const sameAddress = free.find(
      (panel) => panel.url !== undefined && samePage(panel.url, page.url),
    );
    const blank = active
      ? free.find((panel) => panel.url === undefined && panel.page === undefined)
      : undefined;
    if (!take(page, opening ?? sameAddress ?? blank)) opens.push(page);
  }
  return {
    claims,
    opens,
    stale: stale.filter((key) => !claims.has(key)),
    duplicates,
  };
}
