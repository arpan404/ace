import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  tabKey,
  useScopeWorkspace,
  useWorkspaceActions,
  useWorkspaceStore,
} from "@/lib/workspace/index.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { WithServices } from "../with-services.tsx";
import { usePanelServices } from "../services.ts";
import { PageDialog } from "./page-dialog.tsx";
import { desktopBrowserViews } from "@/boot/desktop-browser.ts";
import { reason, useBrowserFeatures } from "./use-browser-features.ts";
import { registerBrowserCloser, setShownBrowserTab } from "./browser-closers.ts";
import { syncBrowserTabs } from "./tab-sync.ts";
import { usePhone } from "@/lib/breakpoints.ts";
import { LocalStore, useLocal } from "../store.ts";
import { BrowserPip } from "./browser-pip.tsx";
import { pipPage } from "./pip-rules.ts";
import { useAutomaticPip } from "./pip-setting.ts";
import { useWatchMode } from "./use-watch-mode.ts";
import { splits } from "./split-view.tsx";

/** Threads whose picture-in-picture the person closed, until their Browser shows again. */
const dismissedPip = new LocalStore<ReadonlySet<string>>(new Set());

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
  const actions = useWorkspaceActions(threadId);
  const phone = usePhone();
  useWatchMode(store, threadId, view, workspace);
  const dismissed = useLocal(dismissedPip, (threads) => threads.has(threadId));
  const [automaticPip] = useAutomaticPip();
  // Only a page the person has looked at in the panel follows them out of it.
  const [seenIn, setSeenIn] = useState<string>();
  if (showingBrowser && seenIn !== threadId) setSeenIn(threadId);
  // Showing the Browser again lets picture-in-picture come back the next time it leaves.
  useEffect(() => {
    if (showingBrowser && dismissedPip.get().has(threadId))
      dismissedPip.set((threads) => new Set([...threads].filter((id) => id !== threadId)));
  }, [showingBrowser, threadId]);
  const floating =
    phone || seenIn !== threadId
      ? undefined
      : pipPage({ view, showingBrowser, dismissed, enabled: automaticPip });
  // Nobody draws the live video while the Browser is out of sight (picture-in-picture says for
  // itself whether its native page shows).
  const floats = !!floating;
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
      {floating && view && (
        <BrowserPip
          source={source}
          threadId={threadId}
          view={view}
          page={floating}
          onRestore={() => actions.activate(tabKey("browser", floating.tabId))}
          onDismiss={() => dismissedPip.set((threads) => new Set(threads).add(threadId))}
        />
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
