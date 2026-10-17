import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useScopeWorkspace } from "@/lib/workspace/index.ts";
import { WithServices } from "../with-services.tsx";
import { usePanelServices } from "../services.ts";
import { PageDialog } from "./page-dialog.tsx";
import { desktopBrowserViews } from "@/boot/desktop-browser.ts";
import { useBrowserFeatures } from "./use-browser-features.ts";
import { registerBrowserCloser } from "./browser-closers.ts";
import { closePersonTabs } from "./use-browser-tabs.ts";

/**
 * The thread's browser while another tool shows: follows it, answers its page dialogs, and
 * knows how to close the person's tabs when the Browser panel tab closes.
 */
function ThreadBrowser(props: { threadId: string }) {
  "use no memo";
  const { preview: source } = usePanelServices();
  const { threadId } = props;
  const workspace = useScopeWorkspace(threadId);
  const browser = useBrowserFeatures(threadId);
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  useEffect(() => source.watch(threadId), [source, threadId]);
  useEffect(
    () =>
      registerBrowserCloser(threadId, () => {
        void closePersonTabs(source, threadId).catch(() => {});
      }),
    [source, threadId],
  );
  const view = source.view(threadId);
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
