import { useCallback, useEffect } from "react";
import {
  findTab,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceTab,
} from "@/lib/workspace/index.ts";
import type { BrowserView, PreviewSource } from "../sources.ts";
import { useLocal } from "../store.ts";
import { browserTabData } from "./browser-state.ts";
import {
  nextBrowserId,
  pageSession,
  registerPageCloser,
  setDismissed,
  setOpening,
} from "./loading.ts";
import { livePages, planPages } from "./page-tabs.ts";
import type { BrowserFeatures } from "./use-browser-features.ts";

const none: ReadonlySet<string> = new Set();

/** A tab of its own for a daemon page: one key per page, so every view agrees on it. */
export const pageTabId = (page: string) => `p-${page}`;

/**
 * Keeps the side panel's browser tabs and the daemon's pages one to one while a browser view is
 * mounted (any number may be: each applies the same plan, so the second finds nothing to do).
 * A page an agent or a link opens gets a tab of its own, named by its site; a tab whose page an
 * agent closed goes, one the person opened keeps its address. When the live page moves to
 * another page (an agent switched, a link opened a new one) and the person was watching it,
 * the panel follows. Closing a tab closes its page, unless it is the thread's last.
 */
export function usePageSync(
  source: PreviewSource,
  threadId: string,
  live: BrowserView | undefined,
  browser: BrowserFeatures,
) {
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(threadId);
  const session = pageSession(source);
  const { followed } = session;
  const opening = useLocal(
    session.opening,
    useCallback((map: ReadonlyMap<string, string>) => map.get(threadId), [threadId]),
  );
  const dismissed = useLocal(
    session.dismissed,
    useCallback(
      (map: ReadonlyMap<string, ReadonlySet<string>>) => map.get(threadId) ?? none,
      [threadId],
    ),
  );
  const { pages, active } = livePages(live);
  const key = `${pages.map((page) => `${page.tabId}=${page.url}`).join("|")}>${active ?? ""}`;
  const controller = live?.controller;

  useEffect(() => {
    if (!pages.length) return;
    // A dismissed page that closed is forgotten.
    for (const page of dismissed)
      if (!pages.some((each) => each.tabId === page)) setDismissed(session, threadId, page, false);
    const browserTabs = () =>
      store.get(threadId).tabs.filter((tab: WorkspaceTab) => tab.kind === "browser");
    const plan = planPages({
      panels: browserTabs().map((tab) => {
        const data = browserTabData(tab);
        return {
          key: tab.key,
          page: data.page,
          url: data.url,
          spawned: data.page !== undefined && tab.id === pageTabId(data.page),
        };
      }),
      pages,
      active,
      opening,
      dismissed,
    });
    const patch = (tabKey: string, change: Record<string, unknown>) => {
      const found = findTab(store.get(threadId), tabKey);
      if (found) actions.update(tabKey, { data: { ...browserTabData(found.tab), ...change } });
    };
    for (const [tabKey, page] of plan.claims) {
      patch(tabKey, { page });
      if (tabKey === opening) setOpening(session, threadId, undefined);
    }
    for (const tabKey of plan.stale) {
      const found = findTab(store.get(threadId), tabKey);
      // An agent's page that closed takes its tab with it; the person's keeps its address.
      if (found && browserTabData(found.tab).agent) void actions.close(tabKey);
      else patch(tabKey, { page: undefined });
    }
    for (const tabKey of plan.duplicates) {
      // Unbound first, so closing it leaves the page to the tab that keeps it.
      patch(tabKey, { page: undefined });
      void actions.close(tabKey);
    }
    for (const page of plan.opens)
      actions.open(
        {
          kind: "browser",
          id: pageTabId(page.tabId),
          data: { url: page.url, page: page.tabId, agent: controller !== "human" },
        },
        { reveal: false },
      );
    // Follow the live page to another page when the person was watching it.
    const before = followed.get(threadId);
    if (active) followed.set(threadId, active);
    if (!active || before === undefined || before === active) return;
    const workspace = store.get(threadId);
    const shown = workspace.open ? findTab(workspace, workspace.active ?? "")?.tab : undefined;
    if (shown?.kind !== "browser" || browserTabData(shown).page !== before) return;
    const next = browserTabs().find((tab) => browserTabData(tab).page === active);
    if (next) actions.activate(next.key);
    // The plan is a function of the pages, the opening tab and the dismissed pages.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, opening, dismissed, threadId, store, actions, session]);

  // A closed tab's page closes with it: the daemon needs the person's control for that, so it
  // is taken just for the close and given back if an agent had it.
  useEffect(() => {
    registerPageCloser(threadId, (page) => {
      // No tab opens for it again while it closes (or, the thread's last, while it stays).
      setDismissed(session, threadId, page, true);
      const current = livePages(source.view(threadId));
      if (current.pages.length <= 1 || !current.pages.some((each) => each.tabId === page)) return;
      const held = source.heldAs(threadId) !== undefined;
      const agent = source.view(threadId)?.controller === "agent";
      void (async () => {
        try {
          if (!held) await source.takeover(threadId);
          await browser.features.closeTab(threadId, page);
        } catch {
          // It stays open, out of the tabs.
        } finally {
          if (!held && agent) await source.handback(threadId).catch(() => {});
        }
      })();
    });
  }, [source, threadId, browser, session]);
}

/** A new browser tab of its own (⌘T, the strip's +, the ⋯ menu): it starts at its address. */
export function useNewBrowserTab(threadId: string): () => void {
  const store = useWorkspaceStore();
  const actions = useWorkspaceActions(threadId);
  return useCallback(
    () =>
      actions.open({
        kind: "browser",
        id: nextBrowserId(store.get(threadId).tabs.map((tab) => tab.key)),
      }),
    [actions, store, threadId],
  );
}
