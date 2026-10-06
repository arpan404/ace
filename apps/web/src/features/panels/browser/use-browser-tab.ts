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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  findTab,
  useWorkspaceActions,
  useWorkspaceStore,
  type WorkspaceTab,
} from "@/lib/workspace/index.ts";
import { useLocal } from "../store.ts";
import type { PreviewSource } from "../sources.ts";
import { viewportById } from "./viewports.ts";
import {
  browserTabData,
  tabHistory,
  useVisited,
  useVisitedStore,
  type BrowserTabData,
} from "./browser-state.ts";
import { bindPage, pageOwners, setLoading } from "./loading.ts";

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
 * One browser tab: its own address and history over the thread's single live page. Going
 * somewhere opens the page if there is none (downloading Chromium the first time), takes the
 * control lease from an agent, navigates, and records where the page landed. Back and Forward
 * use the backend's document history so forms and scroll position survive traversal.
 */
export function useBrowserTab(source: PreviewSource, threadId: string, tab: WorkspaceTab) {
  const page = usePage(source, threadId);
  const actions = useWorkspaceActions(threadId);
  const store = useWorkspaceStore();
  const workspaceId = useThreadMeta(threadId)?.workspaceId;
  const online = useConnectionState() === "ready";
  const visitedStore = useVisitedStore();
  const visited = useVisited(threadId);
  const owner = useLocal(
    pageOwners,
    useCallback((owners: ReadonlyMap<string, string>) => owners.get(threadId), [threadId]),
  );
  const [state, setState] = useState<Phase>({ phase: "idle" });
  const data = browserTabData(tab);
  const history = tabHistory(data);
  const live = page.view && !page.view.closed ? page.view : undefined;
  // This tab shows the live page when it drove it last, or when no tab has and it has no
  // other address of its own.
  const bound =
    live !== undefined &&
    (owner === tab.key ||
      (owner === undefined && (data.url === undefined || samePage(data.url, live.url))));

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
    if (owner === undefined && liveUrl !== undefined) bindPage(threadId, tab.key);
  }, [owner, liveUrl, threadId, tab.key]);
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
        await source.open(threadId, workspaceId);
      }
      if (!source.heldAs(threadId)) await source.takeover(threadId);
      const emulation = viewportById(data.viewport).emulation;
      if (!live && emulation) await source.emulate(threadId, emulation);
      const reachedUrl = await source.navigate(threadId, url);
      bindPage(threadId, tab.key);
      const landed = samePage(next.entries[next.index] ?? "", reachedUrl)
        ? next
        : visitPage(next, reachedUrl);
      save({ url: reachedUrl, history: landed, go: false });
      visitedStore.remember(threadId, reachedUrl);
      setState({ phase: "idle" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState({ phase: "failed", url, failure: describeBrowserFailure(message, url) });
      // The address stays, and so does where Back goes.
      save({ url, history: next, go: false });
    } finally {
      setLoading(threadId, tab.key, false);
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
    owner,
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
