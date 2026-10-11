import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useScopeWorkspace } from "@/lib/workspace/index.ts";
import { WithServices } from "../with-services.tsx";
import { usePanelServices } from "../services.ts";
import { PageDialog } from "./page-dialog.tsx";
import { desktopBrowserViews } from "@/boot/desktop-browser.ts";
import { useBrowserFeatures } from "./use-browser-features.ts";

/** Hold browser ownership for the thread, including while another tool is showing. */
function ThreadBrowser(props: { threadId: string }) {
  "use no memo";
  const { preview: source } = usePanelServices();
  const { threadId } = props;
  const workspace = useScopeWorkspace(threadId);
  const browser = useBrowserFeatures(source, threadId);
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  const opened = useRef(workspace.open);
  const release = () => {
    if (source.heldAs(threadId) && source.view(threadId)?.takeoverMode !== "private")
      void source.handback(threadId).catch(() => {});
  };
  useEffect(() => {
    const stop = source.watch(threadId);
    return () => {
      release();
      stop();
    };
    // Ownership cleanup reads current source state.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [source, threadId]);
  useEffect(() => {
    if (opened.current && !workspace.open) release();
    opened.current = workspace.open;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.open]);
  const view = source.view(threadId);
  const showingBrowser =
    workspace.open &&
    workspace.tabs.some((tab) => tab.key === workspace.active && tab.kind === "browser");
  useEffect(() => {
    if (!showingBrowser)
      source.nativeShown?.(threadId, !!desktopBrowserViews() && view?.backend === "embedded");
  }, [source, threadId, showingBrowser, view?.backend]);
  return view?.pendingDialog && !showingBrowser ? (
    <PageDialog view={view} browser={browser} />
  ) : null;
}
export default function ThreadBrowserBoundary(props: { threadId: string }) {
  return (
    <WithServices quiet>
      <ThreadBrowser {...props} />
    </WithServices>
  );
}
