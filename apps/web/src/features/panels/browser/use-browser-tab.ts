import {
  describeBrowserFailure,
  samePage,
  type AddressSuggestion,
  type BrowserFailure,
} from "@ace/ui-core";
import { useEffect, useState } from "react";
import {
  findTab,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceTab,
} from "@/lib/workspace/index.ts";
import { useToast } from "@/components/ui/toast.tsx";
import type { PreviewSource } from "../sources.ts";
import { browserTabData, type BrowserTabData } from "./browser-data.ts";
import { useVisited, useVisitedStore } from "./browser-state.ts";
import { setLoading } from "./loading.ts";
import type { BrowserTabs } from "./use-browser-tabs.ts";
import { reason } from "./use-browser-features.ts";

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
  const toast = useToast();
  const visitedStore = useVisitedStore();
  const visited = useVisited(threadId);
  const [reported, setState] = useState<Phase>(idle);
  const data = browserTabData(tab);
  const { live, shown, shownId, online } = tabs;
  // Once the tab has committed past a failure, the failure is over for good (adjusted while
  // rendering, so the card is never drawn over the page).
  const superseded =
    reported.phase === "failed" &&
    (reported.tabId === undefined || reported.tabId === shownId) &&
    outlived(reported, shown, live?.loadError);
  const state: Phase = superseded ? idle : reported;
  if (superseded) setState(idle);
  const frame = live ? source.frame(threadId) : undefined;

  /** Merge into the panel tab's data as it is now (a navigation spans several renders). */
  const save = (patch: Partial<BrowserTabData>) => {
    const found = findTab(store.get(threadId), tab.key);
    const current = browserTabData(found?.tab);
    if (Object.entries(patch).every(([key, value]) => Reflect.get(current, key) === value)) return;
    actions.update(tab.key, { data: { ...current, ...patch } });
  };

  // This window's phase belongs to the tab it was started in (or, opening a browser, to the
  // tab that shows); another tab shows its own.
  const own =
    state.phase === "idle" || state.tabId === undefined || state.tabId === shownId ? state : idle;
  const liveUrl = shown?.url;
  const [history, setHistory] = useState<{ key: string; back: boolean; forward: boolean }>();
  const historyKey = `${threadId}|${shownId ?? ""}|${liveUrl ?? ""}`;
  useEffect(() => {
    let current = true;
    if (shownId && source.navigationHistory)
      void source
        .navigationHistory(threadId, shownId)
        .then((value) => {
          if (current) setHistory({ ...value, key: historyKey });
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [source, threadId, shownId, historyKey]);
  const canStep = history?.key === historyKey ? history : { back: false, forward: false };

  // The panel tab names the page it shows (its title, the composer's page list) and whether an
  // agent works in any tab (its working dot).
  const agent = tabs.tabs.some((each) => each.inUse !== undefined);
  useEffect(() => {
    save({ url: liveUrl, agent: agent || undefined });
    if (liveUrl && /^https?:\/\//i.test(liveUrl)) visitedStore.remember(threadId, liveUrl);
    // Only the shown page's address and the agents' work are news here.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUrl, agent]);

  /** The tab's page as the daemon reports it now (`tabId` undefined: the shown one). */
  const tabNow = (tabId: string | undefined) => {
    const view = source.view(threadId);
    const id = tabId ?? view?.activeTabId;
    return view?.tabs?.find((each) => each.tabId === id);
  };

  const run = async (tabId: string | undefined, url: string, work: () => Promise<unknown>) => {
    const from = tabNow(tabId)?.url;
    setLoading(threadId, tab.key, true);
    setState({ phase: "loading", tabId, url });
    try {
      await work();
      setState(idle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = tabNow(tabId);
      setState({
        phase: "failed",
        tabId,
        url,
        failure: describeBrowserFailure(message, url),
        attempt: { from, loading: !!now?.loading },
      });
    } finally {
      setLoading(threadId, tab.key, false);
    }
  };

  /** The shown tab goes to `url`; with no browser yet, one opens with it. */
  const go = (url: string) => {
    const target = shownId;
    if (!live || !target) {
      void run(undefined, url, () => tabs.open(url));
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

  // Opened with an address (the launcher's bar, Suggested, a link): it opens once, in a new
  // tab, as soon as a browser can be reached. The request is dropped before it runs, so a
  // re-render or another window can never open it twice. A failed load shows in that tab.
  const pending = data.open;
  useEffect(() => {
    if (!pending || !online || !tabs.reachable) return;
    save({ open: undefined });
    void tabs.open().then(
      (tabId) => {
        if (tabId) void run(tabId, pending, () => source.navigate(threadId, pending, tabId));
      },
      (error: unknown) =>
        toast.error({ title: `Couldn't open ${pending}`, description: reason(error) }),
    );
    // `tabs.open` closes over this render's browser; the address is what matters.
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
    state: own,
    loading: own.phase === "loading" || !!shown?.loading || !!live?.loading,
    /** The address the bar shows: what is loading or failed here, else the tab's own. */
    shownUrl: own.phase === "idle" ? liveUrl : own.url,
    suggestions,
    download: source.download(),
    canBack: uncommitted || canStep.back,
    canForward: canStep.forward,
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
