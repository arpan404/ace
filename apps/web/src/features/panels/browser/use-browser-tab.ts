import {
  describeBrowserFailure,
  samePage,
  type AddressSuggestion,
  type BrowserFailure,
} from "@ace/ui-core";
import { useCallback, useEffect } from "react";
import {
  findTab,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceTab,
} from "@/lib/workspace/index.ts";
import { LocalStore, useLocal } from "../store.ts";
import type { PreviewSource } from "../sources.ts";
import { browserTabData, type BrowserTabData } from "./browser-data.ts";
import { useVisited, useVisitedStore } from "./browser-state.ts";
import { setLoading } from "./loading.ts";
import type { BrowserTabs } from "./use-browser-tabs.ts";

/** A navigation this window started in one tab, or how it failed. */
type Phase =
  | { phase: "idle" }
  | { phase: "loading"; tabId: string | undefined; url: string }
  | {
      phase: "failed";
      tabId: string | undefined;
      url: string;
      failure: BrowserFailure;
      /** The tab's address when the navigation began, and whether the tab was still loading
       * when the failure came. They tell a later commit from the page before. */
      attempt: { from: string | undefined; loading: boolean };
    };

const idle: Phase = { phase: "idle" };

/**
 * Each tab's navigation phase, by `threadId\0tab`: outside the view, because a new tab becomes
 * the daemon tab it opened (a new panel tab) while its first page is still loading or failing.
 */
const phases = new LocalStore<ReadonlyMap<string, Phase>>(new Map());
const phaseKey = (threadId: string, tab: string) => `${threadId}\u0000${tab}`;
function setPhase(key: string, phase: Phase) {
  phases.set((current) => {
    if (current.get(key) === phase) return current;
    const next = new Map(current);
    if (phase.phase === "idle") next.delete(key);
    else next.set(key, phase);
    return next;
  });
}

const web = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

/**
 * A failure the page has outlived: the navigation reported an error that isn't Chromium's own
 * load error (a timeout, a cancelled wait), yet the tab has since committed a web document of
 * its own (its address moved on, or the asked-for page finished loading) with no load error.
 * The live page is what the person should see, not a card over it.
 */
function outlived(
  state: Phase,
  tab: { url: string; loading?: boolean | undefined } | undefined,
  loadError: string | undefined,
): boolean {
  if (state.phase !== "failed" || state.failure.code) return false;
  if (!tab || loadError || !web(tab.url)) return false;
  if (tab.url !== state.attempt.from) return true;
  // The same address as before: only the asked-for page, loaded since, outlives the failure.
  return state.attempt.loading && !tab.loading && samePage(tab.url, state.url);
}

/**
 * The page in the tab the person views: its address, Back, Forward, Reload and Stop, always in
 * that exact tab (every command names it), never whichever tab happens to be shown when the
 * daemon gets it. Going somewhere with no browser yet opens one. An address the panel tab was
 * opened with (the launcher, Suggested, a link) opens once, in a new tab of its own.
 */
export function useBrowserTab(
  source: PreviewSource,
  threadId: string,
  tab: WorkspaceTab,
  tabs: BrowserTabs,
) {
  const actions = useWorkspaceActions(threadId);
  const store = useWorkspaceStore();
  const visitedStore = useVisitedStore();
  const visited = useVisited(threadId);
  const data = browserTabData(tab);
  const { live, shown, shownId, online } = tabs;
  const key = phaseKey(threadId, shownId ?? `new:${tab.key}`);
  const reported = useLocal(
    phases,
    useCallback((all: ReadonlyMap<string, Phase>) => all.get(key) ?? idle, [key]),
  );
  const setState = (phase: Phase) => setPhase(key, phase);
  // Once the tab has committed past a failure, the failure is over for good (adjusted while
  // rendering, so the card is never drawn over the page).
  const superseded =
    reported.phase === "failed" &&
    (reported.tabId === undefined || reported.tabId === shownId) &&
    outlived(reported, shown, live?.loadError);
  const state: Phase = superseded ? idle : reported;
  useEffect(() => {
    if (superseded) setPhase(key, idle);
  }, [superseded, key]);
  // The video follows the daemon's shown tab: it is this tab's picture only once shown, and
  // until its first keyframe decodes the tab keeps the last picture this client saw of it.
  // Another tab's half of a split view keeps that tab's last picture meanwhile.
  const still = shownId ? source.still?.(threadId, shownId) : undefined;
  const frame = !live
    ? undefined
    : live.activeTabId === shownId
      ? (source.frame(threadId) ?? still)
      : still;

  /** Merge into the panel tab's data as it is now (a navigation spans several renders). */
  const save = (patch: Partial<BrowserTabData>) => {
    const found = findTab(store.get(threadId), tab.key);
    const current = browserTabData(found?.tab);
    if (Object.entries(patch).every(([field, value]) => Reflect.get(current, field) === value))
      return;
    actions.update(tab.key, { data: { ...current, ...patch } });
  };

  // This window's phase belongs to the tab it was started in (or, opening a browser, to the
  // tab that shows); another tab shows its own.
  const own =
    state.phase === "idle" || state.tabId === undefined || state.tabId === shownId ? state : idle;
  const liveUrl = shown?.url;

  // The thread remembers the web pages it showed, for the address bar's suggestions.
  useEffect(() => {
    if (liveUrl && /^https?:\/\//i.test(liveUrl)) visitedStore.remember(threadId, liveUrl);
  }, [liveUrl, threadId, visitedStore]);

  /** The tab's page as the daemon reports it now (`tabId` undefined: the shown one). */
  const tabNow = (tabId: string | undefined) => {
    const view = source.view(threadId);
    const id = tabId ?? view?.activeTabId;
    return view?.tabs?.find((each) => each.tabId === id);
  };

  /** Navigate `tabId` (its phase kept under its own key, whichever panel tab shows it). */
  const run = async (tabId: string, url: string, work: () => Promise<unknown>) => {
    const at = phaseKey(threadId, tabId);
    const panelKey = `browser:${tabId}`;
    const from = tabNow(tabId)?.url;
    setLoading(threadId, panelKey, true);
    setPhase(at, { phase: "loading", tabId, url });
    try {
      await work();
      setPhase(at, idle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = tabNow(tabId);
      setPhase(at, {
        phase: "failed",
        tabId,
        url,
        failure: describeBrowserFailure(message, url),
        attempt: { from, loading: !!now?.loading },
      });
    } finally {
      setLoading(threadId, panelKey, false);
    }
  };

  /**
   * A new tab's address: a daemon tab opens for it (with the thread's browser, the first time)
   * and this panel tab becomes that tab, then the page loads there. A failure to open the
   * browser stays on this new tab.
   */
  const openHere = async (url: string) => {
    const pendingKey = phaseKey(threadId, `new:${tab.key}`);
    setLoading(threadId, tab.key, true);
    setPhase(pendingKey, { phase: "loading", tabId: undefined, url });
    let tabId: string | undefined;
    try {
      tabId = await tabs.open();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPhase(pendingKey, {
        phase: "failed",
        tabId: undefined,
        url,
        failure: describeBrowserFailure(message, url),
        attempt: { from: undefined, loading: false },
      });
      return;
    } finally {
      setLoading(threadId, tab.key, false);
    }
    setPhase(pendingKey, idle);
    if (!tabId) return;
    const opened = tabId;
    const current = browserTabData(findTab(store.get(threadId), tab.key)?.tab);
    const { open: _open, ...kept } = current;
    actions.replace(tab.key, { kind: "browser", id: opened, data: kept });
    await run(opened, url, () => source.navigate(threadId, url, opened));
  };

  /** The shown tab goes to `url`; a new tab opens its daemon tab first. */
  const go = (url: string) => {
    const target = shownId;
    if (!target) {
      void openHere(url);
      return;
    }
    void run(target, url, () => source.navigate(threadId, url, target));
  };

  const step = (direction: "back" | "forward" | "reload") => {
    const target = shownId;
    const traverse = source.navigateHistory;
    if (!target || !traverse) return;
    void run(target, liveUrl ?? "", () => traverse(threadId, direction, target));
  };

  // Opened with an address (the launcher's bar, Suggested, a link): it opens once, as soon as
  // a browser can be reached. The request is dropped before it runs, so a re-render or another
  // window can never open it twice.
  const pending = data.open;
  useEffect(() => {
    if (!pending || shownId || !online || !tabs.reachable) return;
    save({ open: undefined });
    void openHere(pending);
    // `openHere` closes over this render's browser; the address is what matters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, online, tabs.reachable]);

  // A refused navigation can leave the tab's own page intact: Back dismisses the attempt.
  const uncommitted = own.phase === "failed" && liveUrl !== undefined && own.url !== liveUrl;
  const suggestions: AddressSuggestion[] = [
    ...source.servers(threadId).map((server) => ({
      url: server.origin ?? `http://localhost:${server.port}`,
      label: server.name ?? `localhost:${server.port}`,
      detail: `Dev server · port ${server.port}`,
    })),
    ...visited.map((url) => ({ url, label: url.replace(/^https?:\/\//, ""), detail: "Visited" })),
  ];

  return {
    data,
    frame,
    /** Whether this client can show a live page at all (it streams only as video). */
    decodesVideo: source.decodesVideo?.(),
    state: own,
    loading: own.phase === "loading" || !!shown?.loading || !!live?.loading,
    /** The address the bar shows: what is loading or failed here, else the tab's own. */
    shownUrl: own.phase === "idle" ? liveUrl : own.url,
    suggestions,
    download: source.download(),
    // The daemon keeps these current through every navigation, in-page ones included.
    canBack: uncommitted || shown?.canGoBack === true,
    canForward: shown?.canGoForward === true,
    go,
    back: () => (uncommitted ? setState(idle) : step("back")),
    forward: () => step("forward"),
    reload: () => {
      if (own.phase === "failed") go(own.url);
      else step("reload");
    },
    stop: () => {
      const target = shownId;
      if (target) void source.navigateHistory?.(threadId, "stop", target).catch(() => {});
    },
    save,
  };
}
