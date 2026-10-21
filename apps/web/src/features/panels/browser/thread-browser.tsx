import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useScopeWorkspace, useWorkspaceStore } from "@/lib/workspace/index.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { WithServices } from "../with-services.tsx";
import { usePanelServices } from "../services.ts";
import { PageDialog } from "./page-dialog.tsx";
import { desktopBrowserViews } from "@/boot/desktop-browser.ts";
import { reason, useBrowserFeatures } from "./use-browser-features.ts";
import { registerBrowserCloser, setShownBrowserTab } from "./browser-closers.ts";
import { syncBrowserTabs } from "./tab-sync.ts";
import { useLocal } from "../store.ts";
import {
  addThread,
  browsersOnScreen,
  dismissedPip,
  floatingThreads,
  removeThread,
  seenBrowsers,
} from "./floating-state.ts";
import { useWatchMode } from "./use-watch-mode.ts";
import { splits } from "./split-view.tsx";

/**
 * The thread's browser for as long as the thread shows: keeps the panel's browser tabs in step
 * with the daemon's tabs (one panel tab each), closes a daemon tab when its panel tab closes,
 * and answers page dialogs while another tool shows.
 */
function ThreadBrowser(props: { threadId: string }) {
  "use no memo";
  const { preview: source } = usePanelServices();
  const { threadId } = props;
  const store = useWorkspaceStore();
  const workspace = useScopeWorkspace(threadId);
  const browser = useBrowserFeatures(threadId);
  const toast = useToast();
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  useEffect(() => source.watch(threadId), [source, threadId]);
  const memory = useRef<{
    active: string | undefined;
    closing: Set<string>;
    seen: boolean;
    split?: readonly string[] | undefined;
  }>({
    active: undefined,
    closing: new Set(),
    seen: false,
  });
  useEffect(
    () =>
      registerBrowserCloser(threadId, (tabId) => {
        memory.current.closing.add(tabId);
        void source.closeTab(threadId, tabId).catch((error: unknown) => {
          memory.current.closing.delete(tabId);
          toast.error({ title: "Couldn't close the tab", description: reason(error) });
        });
      }),
    [source, threadId, toast],
  );
  const view = source.view(threadId);
  useEffect(() => {
    const daemon = view && {
      closed: view.closed,
      tabs: view.tabs ?? [],
      activeTabId: view.activeTabId,
    };
    const split = splits.get().get(threadId);
    memory.current.split = split ? [split.left, split.right] : undefined;
    store.update(threadId, (current) => syncBrowserTabs(current, daemon, memory.current));
    if (!daemon) return;
    const listed = new Set(daemon.closed ? [] : daemon.tabs.map((tab) => tab.tabId));
    for (const id of memory.current.closing) if (!listed.has(id)) memory.current.closing.delete(id);
    const active = daemon.closed ? undefined : daemon.activeTabId;
    memory.current.active = active !== undefined && listed.has(active) ? active : undefined;
    memory.current.seen = true;
    setShownBrowserTab(threadId, memory.current.active);
  }, [store, threadId, view]);
  useEffect(() => () => setShownBrowserTab(threadId, undefined), [threadId]);
  const showingBrowser =
    workspace.open &&
    workspace.tabs.some((tab) => tab.key === workspace.active && tab.kind === "browser");
  useWatchMode(store, threadId, view, workspace);
  // Only a page the person has looked at in the panel follows them out of it, into a floating
  // window (`floating-browsers.tsx`); showing the Browser again lets a closed one come back.
  useEffect(() => {
    if (!showingBrowser) return;
    addThread(seenBrowsers, threadId);
    addThread(browsersOnScreen, threadId);
    removeThread(dismissedPip, threadId);
    return () => removeThread(browsersOnScreen, threadId);
  }, [showingBrowser, threadId]);
  // Nobody draws the live video while the Browser is out of sight and its page doesn't float.
  const floats = useLocal(floatingThreads, (threads) => threads.has(threadId));
  useEffect(() => {
    if (!showingBrowser && !floats)
      source.nativeShown?.(threadId, !!desktopBrowserViews() && view?.backend === "embedded");
  }, [source, threadId, showingBrowser, floats, view?.backend]);
  return (
    <>
      {view?.pendingDialog && !showingBrowser && (
        <div className="pointer-events-auto overflow-hidden rounded-popup ace-floating-solid shadow-glass">
          <PageDialog view={view} browser={browser} />
        </div>
      )}
    </>
  );
}
export default function ThreadBrowserBoundary(props: { threadId: string }) {
  return (
    <WithServices quiet>
      <ThreadBrowser {...props} />
    </WithServices>
  );
}
