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
 * re-open this tab's earlier addresses; the relay has no history commands, so a page's own
 * state (forms, scroll) isn't restored.
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
      if (source.view(threadId)?.controller !== "human") await source.takeover(threadId);
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

  // Opened with an address (the launcher's bar, Suggested): go there once.
  const pending = data.go === true && data.url ? data.url : undefined;
  useEffect(() => {
    if (!pending || !online) return;
    let current = true;
    void Promise.resolve().then(() => {
      if (current) void go(pending);
    });
    return () => {
      current = false;
    };
    // `go` closes over this render's page; the address is what matters.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, online]);

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
    canBack: canStep(history, -1),
    canForward: canStep(history, 1),
    go: (url: string) => void go(url),
    reload: () => {
      const url = state.phase === "failed" ? state.url : (data.url ?? live?.url);
      if (url) void go(url, history);
    },
    back: () => step(-1),
    forward: () => step(1),
    save,
  };
}
