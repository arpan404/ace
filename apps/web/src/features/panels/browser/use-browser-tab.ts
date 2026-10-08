import { useConnectionState, useThreadMeta } from "@ace/client-react";
import {
  canStep,
  describeBrowserFailure,
  samePage,
  stepHistory,
  visitPage,
  type AddressSuggestion,
  type BrowserFailure,
} from "@ace/ui-core";
import type { BrowserFeaturesClient } from "@ace/client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  findTab,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceTab,
} from "@/lib/workspace/index.ts";
import type { PreviewSource } from "../sources.ts";
import { viewportById } from "./viewports.ts";
import {
  browserTabData,
  tabHistory,
  useVisited,
  useVisitedStore,
  type BrowserTabData,
} from "./browser-state.ts";
import { pageSession, setDismissed, setLoading, setOpening } from "./loading.ts";
import { livePages } from "./page-tabs.ts";

/** The thread's page as the browser service reports it, re-read on each change to the thread. */
function usePage(source: PreviewSource, threadId: string) {
  // The source's reads change with its version; read them again on each one.
  "use no memo";
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  // Follow the thread's page and dev servers only while this tab shows them.
  useEffect(() => source.watch(threadId), [source, threadId]);
  return {
    view: source.view(threadId),
    frame: source.frame(threadId),
    servers: source.servers(threadId),
    download: source.download(),
    /** The connection through which this client holds the page, while it does. */
    heldAs: source.heldAs(threadId),
  };
}

type Phase =
  | { phase: "idle" }
  | { phase: "loading"; url: string }
  | { phase: "failed"; url: string; failure: BrowserFailure };

/**
 * One browser tab: one of the thread's pages (`page-tabs.ts`), with its own address and
 * history. Going somewhere opens the thread's browser if there is none (downloading Chromium the
 * first time) or a page of its own if it has none, takes the control lease from an agent,
 * navigates, and records where the page landed. Back and Forward use the backend's document
 * history so forms and scroll position survive traversal. The tab shows its page live while it
 * is the session's active page; otherwise it waits in the background.
 */
export function useBrowserTab(
  source: PreviewSource,
  threadId: string,
  tab: WorkspaceTab,
  features: Pick<BrowserFeaturesClient, "openTab" | "switchTab">,
) {
  const page = usePage(source, threadId);
  const session = pageSession(source);
  const actions = useWorkspaceActions(threadId);
  const store = useWorkspaceStore();
  const workspaceId = useThreadMeta(threadId)?.workspaceId;
  const online = useConnectionState() === "ready";
  const visitedStore = useVisitedStore();
  const visited = useVisited(threadId);
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const data = browserTabData(tab);
  const history = tabHistory(data);
  const live = page.view && !page.view.closed ? page.view : undefined;
  const { pages, active } = livePages(live);
  const own = pages.find((each) => each.tabId === data.page);
  // This tab shows the live page while its page is the session's active one.
  const bound = live !== undefined && own !== undefined && own.tabId === active;
  /** Its page, open in the background while another page is the active one. */
  const background = own && !bound ? own : undefined;

  /** Merge into the tab's data as it is now (a navigation spans several renders). */
  const save = (patch: Partial<BrowserTabData>) => {
    const found = findTab(store.get(threadId), tab.key);
    const current = found ? browserTabData(found.tab) : {};
    actions.update(tab.key, { data: { ...current, ...patch } });
  };

  // The page moved on its own (a link, a redirect, an agent): this tab follows it.
  const liveUrl = bound ? live.url : undefined;
  const [loadedHistory, setNativeHistory] = useState<{
    key: string;
    back: boolean;
    forward: boolean;
  }>();
  const activeTab = live?.activeTabId;
  const historyKey = `${threadId}|${activeTab ?? ""}|${liveUrl ?? ""}`;
  const nativeHistory = loadedHistory?.key === historyKey ? loadedHistory : undefined;
  useEffect(() => {
    let current = true;
    if (bound && source.navigationHistory)
      void source
        .navigationHistory(threadId)
        .then((value) => {
          if (current) setNativeHistory({ ...value, key: historyKey });
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [source, threadId, historyKey, bound]);
  const navigateHistory = async (direction: "back" | "forward" | "reload") => {
    try {
      if (!source.heldAs(threadId)) await source.takeover(threadId);
      await source.navigateHistory?.(threadId, direction);
      setState({ phase: "idle" });
    } catch (error) {
      setState({
        phase: "failed",
        url: liveUrl ?? data.url ?? "",
        failure: describeBrowserFailure(
          error instanceof Error ? error.message : String(error),
          liveUrl ?? "",
        ),
      });
    }
  };
  useEffect(() => {
    if (!liveUrl || liveUrl === "about:blank") return;
    const current = history.entries[history.index];
    if (current !== undefined && samePage(current, liveUrl)) return;
    save({ url: liveUrl, history: visitPage(history, liveUrl) });
    visitedStore.remember(threadId, liveUrl);
    // Only a change of the page's address is news here.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUrl]);

  const go = async (url: string, next = visitPage(history, url)) => {
    setLoading(threadId, tab.key, true);
    setState({ phase: "loading", url });
    save({ url, go: false });
    try {
      if (!live) {
        if (!workspaceId) throw new Error("The thread's project isn't known yet.");
        // The new session's first page is this tab's.
        setOpening(session, threadId, tab.key);
        await source.open(threadId, workspaceId);
      }
      if (!source.heldAs(threadId)) await source.takeover(threadId);
      const emulation = viewportById(data.viewport).emulation;
      if (!live && emulation) await source.emulate(threadId, emulation);
      let target = own?.tabId;
      if (live && target === undefined) {
        // A page whose tab the person closed is reused before another opens.
        const spare = pages.find((each) => session.dismissed.get().get(threadId)?.has(each.tabId));
        if (spare) {
          setDismissed(session, threadId, spare.tabId, false);
          target = spare.tabId;
        } else {
          setOpening(session, threadId, tab.key);
          const opened = await features.openTab(threadId);
          if ("pending_dialog" in opened) throw new Error("Answer the page's question first.");
          target = opened.activeTabId;
        }
        save({ page: target });
      }
      if (target !== undefined && target !== source.view(threadId)?.activeTabId) {
        const switched = await features.switchTab(threadId, target);
        if ("pending_dialog" in switched) throw new Error("Answer the page's question first.");
      }
      const reachedUrl = await source.navigate(threadId, url);
      const landed = samePage(next.entries[next.index] ?? "", reachedUrl)
        ? next
        : visitPage(next, reachedUrl);
      save({
        url: reachedUrl,
        history: landed,
        go: false,
        page: target ?? source.view(threadId)?.activeTabId,
      });
      visitedStore.remember(threadId, reachedUrl);
      setState({ phase: "idle" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({ phase: "failed", url, failure: describeBrowserFailure(message, url) });
      // The address stays, and so does where Back goes.
      save({ url, history: next, go: false });
    } finally {
      setLoading(threadId, tab.key, false);
      setOpening(session, threadId, undefined);
    }
  };

  // Opened with an address (the launcher's bar, Suggested): go there once, as soon as the page
  // can be reached: the thread's live page, or its project to open one in (the thread's details
  // can arrive a moment after the tab mounts).
  const pending = data.go === true && data.url ? data.url : undefined;
  const reachable = live !== undefined || workspaceId !== undefined;
  useEffect(() => {
    if (!pending || !online || !reachable) return;
    let current = true;
    void Promise.resolve().then(() => {
      if (current) void go(pending);
    });
    return () => {
      current = false;
    };
    // `go` closes over this render's page; the address is what matters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, online, reachable]);

  // Refused navigation can leave the current document intact. Back dismisses that
  // attempted address without traversing past (or reloading) the retained document.
  const uncommittedFailure =
    state.phase === "failed" && bound && liveUrl !== undefined && state.url !== liveUrl;
  const back = () => {
    if (uncommittedFailure && liveUrl !== undefined) {
      save({ url: liveUrl, history: visitPage(stepHistory(history, -1), liveUrl) });
      setState({ phase: "idle" });
    } else if (source.navigateHistory && bound) void navigateHistory("back");
    else step(-1);
  };

  const step = (delta: -1 | 1) => {
    const next = stepHistory(history, delta);
    const target = next.entries[next.index];
    if (target !== undefined && next !== history) void go(target, next);
  };

  const suggestions: AddressSuggestion[] = [
    ...page.servers.map((server) => ({
      url: server.origin ?? `http://localhost:${server.port}`,
      label: server.name ?? `localhost:${server.port}`,
      detail: `Dev server · port ${server.port}`,
    })),
    ...visited.map((url) => ({ url, label: url.replace(/^https?:\/\//, ""), detail: "Visited" })),
  ];

  return {
    ...page,
    live,
    bound,
    background,
    online,
    data,
    state,
    suggestions,
    canBack: uncommittedFailure || (nativeHistory?.back ?? canStep(history, -1)),
    canForward: nativeHistory?.forward ?? canStep(history, 1),
    go: (url: string) => void go(url),
    reload: () => {
      if (bound && source.navigateHistory && state.phase !== "failed") {
        void navigateHistory("reload");
        return;
      }
      const url = state.phase === "failed" ? state.url : (data.url ?? live?.url);
      if (url) void go(url, history);
    },
    back,
    forward: () => (source.navigateHistory && bound ? void navigateHistory("forward") : step(1)),
    save,
  };
}
