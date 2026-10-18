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
  const memory = useRef<{ active: string | undefined; closing: Set<string>; seen: boolean }>({
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
  useEffect(() => {
    if (!showingBrowser)
      source.nativeShown?.(threadId, !!desktopBrowserViews() && view?.backend === "embedded");
  }, [source, threadId, showingBrowser, view?.backend]);
  return view?.pendingDialog && !showingBrowser ? (
    <div className="pointer-events-auto overflow-hidden rounded-popup ace-floating-solid shadow-glass">
      <PageDialog view={view} browser={browser} />
    </div>
  ) : null;
}
export default function ThreadBrowserBoundary(props: { threadId: string }) {
  return (
    <WithServices quiet>
      <ThreadBrowser {...props} />
    </WithServices>
  );
}
