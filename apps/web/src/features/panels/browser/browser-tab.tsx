import { desktopBrowserViews, type BrowserAccelerator } from "@/boot/desktop-browser.ts";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { displayAddress, describeBrowserFailure } from "@ace/ui-core";
import { useEffectEvent, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { WithServices } from "../with-services.tsx";
import { FindPage } from "./find-page.tsx";
import { AddressBar } from "./address-bar.tsx";
import { addressTakesFocus } from "./address-focus.ts";
import { PageDialog } from "./page-dialog.tsx";
import { PageSignIn } from "./page-sign-in.tsx";
import { PageFileChooser } from "./page-file-chooser.tsx";
import { useBrowserFeatures } from "./use-browser-features.ts";
import { BrowserActions } from "./browser-actions.tsx";
import { SpeakerButton } from "./speaker-button.tsx";
import { DownloadsButton } from "./downloads.tsx";
import { ExtensionsMenu, extensionsHidden } from "./extensions-menu.tsx";
import { PageNav, PageToolbar, ToolPill } from "./page-toolbar.tsx";
import { daemonTabId } from "./browser-data.ts";
import { AnnotateButton } from "./annotate-button.tsx";
import { useNativeView } from "./native-view.ts";
import { CoverPicture, useCoverStill } from "./cover-picture.tsx";
import {
  CertificateWarning,
  Disconnected,
  LoadFailed,
  Offline,
  Opening,
  StartPage,
} from "./page-states.tsx";
import { PageView } from "./page-view.tsx";
import { RecordingIndicator } from "./recording-indicator.tsx";
import { useCursorStyle } from "./use-cursor-style.ts";
import { usePageCursor } from "./use-page-state.ts";
import { ConnectionMark } from "./connection-mark.tsx";
import { useBrowserTab } from "./use-browser-tab.ts";
import { useBrowserTabs } from "./use-browser-tabs.ts";
import { usePageTools } from "./use-page-tools.ts";
import { usePageChrome } from "./use-page-chrome.tsx";
import { DeviceToolbar } from "./device-toolbar.tsx";
import { DeviceStage } from "./device-stage.tsx";
import { ZoomBadge } from "./zoom-controls.tsx";
import { ConsoleDrawer, drawerHeights } from "./console-drawer.tsx";
import { ResponsiveScreenshotDialog } from "./responsive-screenshot.tsx";
import { rememberPageSize } from "./page-size.ts";
import { WatchButton, useWatchToggle } from "./watch-button.tsx";
import { SplitBrowser, openSplit, splits, type SplitPane } from "./split-view.tsx";
import { useSplitDrop } from "./split-drop.tsx";

const permissionLabel = (permission: string) =>
  ({
    media: "camera or microphone",
    geolocation: "location",
    notifications: "notifications",
    "clipboard-sanitized-write": "clipboard",
  })[permission] ?? "a site permission";

/**
 * One of the thread's browser tabs, as a panel tab (each daemon tab is its own panel tab, the
 * person's and every agent's alike, the same on every device): its toolbar and the page itself.
 * Showing it shows that tab to the person on every device. The person and agents share every
 * tab: anyone can click, type or navigate anywhere at any time, and an agent's work shows as its
 * cursor on the panel tab and over the page. The page fills the panel on ace's own surface (or
 * the desktop's native view); a failed load keeps its address with Reload.
 */
function Browser(props: TabViewProps & { pane?: SplitPane | undefined }) {
  const pane = props.pane;
  const [finding, setFinding] = useState(false);
  const [sizing, setSizing] = useState(false);
  const threadId = props.scope;
  const ownId = daemonTabId(props.tab);
  const { preview: source } = usePanelServices();
  const actions = useWorkspaceActions(threadId);
  const browser = useBrowserFeatures(threadId);
  const tabs = useBrowserTabs(source, threadId, ownId);
  const page = useBrowserTab(source, threadId, props.tab, tabs);
  const extensionsOff = useLocal(extensionsHidden, (value) => value);
  const { live, shown, online } = tabs;
  useCursorStyle(source, threadId);
  /** The cursor shape the shown tab's page reports under the person's pointer. */
  const pageCursor = usePageCursor(source, threadId, shown?.tabId);

  // Showing this panel tab shows its daemon tab, here and on the person's other devices. Only
  // showing it asks: when the daemon later shows another tab, the panel follows it instead.
  const reachable = !!live && live.status !== "paused";
  useEffect(() => {
    // In split view only the half the person works in is the shown tab.
    if (ownId && reachable && (pane?.focused ?? true)) tabs.select(ownId);
    // `tabs.select` reads the daemon's shown tab of this render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [ownId, reachable, pane?.focused]);
  // A tab kept from before a daemon restart: its browser opens again, with the same tabs.
  const unopened = ownId !== undefined && !live && online && tabs.reachable;
  useEffect(() => {
    if (unopened) void tabs.ensure();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [unopened]);

  const watch = useWatchToggle(threadId, live);
  const drop = useSplitDrop(pane ? undefined : ownId, (other) => {
    if (ownId) openSplit(threadId, ownId, other);
  });
  // Live while dragging; saved with the tab when the drag ends.
  const [drawerHeight, setDrawerHeight] = useState<number>();
  const drawer = page.data.drawer;
  const shownUrl = page.shownUrl;
  const blank = !shownUrl || shownUrl === "about:blank";
  const offline = online ? undefined : "ace is offline";
  const external = shownUrl && /^https?:\/\//i.test(shownUrl) ? shownUrl : undefined;
  // In the desktop app the page itself is a native view drawn over this tab's page area (or
  // over the device toolbar's frame).
  const pageArea = useRef<HTMLDivElement>(null);
  const deviceFrame = useRef<HTMLDivElement>(null);
  const tools = usePageTools({
    source,
    threadId,
    live,
    tab: shown,
    online,
    area: () => pageArea.current?.getBoundingClientRect(),
  });
  const native = useNativeView(
    threadId,
    tools.toolbar ? deviceFrame : pageArea,
    !!live &&
      !blank &&
      live.backend === "embedded" &&
      live.status !== "paused" &&
      live.status !== "recovering" &&
      online &&
      page.state.phase !== "failed" &&
      !shown?.certificateError,
    {
      device: tools.emulation,
      exact: tools.toolbar,
      ...(pane ? { tabId: pane.tabId } : {}),
    },
  );
  // The native view owns the page, even while it steps out from under a menu.
  const nativePage = native.shown || native.frozen !== undefined;
  // Out from under a menu, the page is drawn from the live screencast (once a fresh frame
  // replaces the still taken as the menu opened), so it keeps moving while the menu shows.
  const still = useCoverStill(native.frozen, page.frame?.sequence);
  // Picture-in-picture lays the page out at the size it had here.
  useEffect(() => {
    const element = pageArea.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      rememberPageSize(threadId, element.clientWidth, element.clientHeight),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [threadId]);

  useEffect(() => {
    source.nativeShown?.(threadId, native.shown);
    return () => source.nativeShown?.(threadId, !!desktopBrowserViews());
  }, [source, threadId, native.shown]);

  const root = useRef<HTMLDivElement>(null);
  // Focus leaves the renderer when the person clicks into the desktop's native page (or another
  // app): let go of the chrome's focused control so no focus ring stays drawn meanwhile. An
  // address being edited keeps its focus and its draft.
  useEffect(() => {
    const release = () => {
      const focused = document.activeElement;
      if (
        focused instanceof HTMLElement &&
        root.current?.contains(focused) &&
        !focused.hasAttribute("data-editing")
      )
        focused.blur();
    };
    addEventListener("blur", release);
    return () => removeEventListener("blur", release);
  }, []);
  const focusAddress = () =>
    root.current?.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.focus();
  // A tab that opens blank starts at its address, unless an agent opened it or the person is
  // typing elsewhere, in the composer (`addressTakesFocus`). Only as the tab opens.
  const [openedBlank] = useState(blank);
  const openFocus = useEffectEvent(() => {
    const element = root.current;
    if (
      element &&
      addressTakesFocus({
        openedByAgent: shown?.openedBy?.kind === "agent",
        active: element.ownerDocument.activeElement,
        panel: element.closest("[data-panel]") ?? element,
      })
    )
      focusAddress();
  });
  useEffect(() => {
    if (openedBlank) openFocus();
  }, [openedBlank]);
  const chrome = usePageChrome({
    source,
    threadId,
    live,
    tab: shown,
    nativeShown: nativePage,
    page,
    tools,
    openTab: (url) => tabs.open(url),
    onKey: (key) =>
      shortcut(
        (
          {
            address: "CmdOrCtrl+L",
            find: "CmdOrCtrl+F",
            reload: "CmdOrCtrl+R",
            back: "CmdOrCtrl+[",
            forward: "CmdOrCtrl+]",
          } as const
        )[key],
      ),
  });
  const shortcut = (accelerator: BrowserAccelerator) => {
    if (accelerator === "CmdOrCtrl+L") focusAddress();
    else if (accelerator === "CmdOrCtrl+F") setFinding(true);
    else if (accelerator === "CmdOrCtrl+R") page.reload();
    else if (accelerator === "CmdOrCtrl+T") actions.open({ kind: "browser" });
    else if (accelerator === "CmdOrCtrl+[") page.back();
    else if (accelerator === "CmdOrCtrl+]") page.forward();
  };
  const nativeShortcut = useEffectEvent((id: string, accelerator: BrowserAccelerator) => {
    if (id === threadId) shortcut(accelerator);
  });
  useEffect(() => desktopBrowserViews()?.onShortcut(nativeShortcut), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The tab's own browser keys win over the app's (⌘[ is app Back, ⌘P files elsewhere).
    if (!chrome.key(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const certificate = shown?.certificateError;
  let content;
  if (live?.status === "paused" && live.pageStateLost)
    content = <Disconnected reason={live.reason} onReopen={tabs.reopen} />;
  else if (shown && certificate)
    content = (
      <CertificateWarning
        url={certificate.url}
        error={certificate.error}
        onReload={() => page.go(certificate.url)}
        onProceed={() => void browser.proceedCertificate(shown.tabId, certificate.url)}
      />
    );
  else if (page.state.phase === "failed")
    content = (
      <LoadFailed url={page.state.url} failure={page.state.failure} onReload={page.reload} />
    );
  else if (live && shown && !blank && live.loadError && live.url === shown.url)
    content = (
      <LoadFailed
        url={shown.url}
        failure={describeBrowserFailure(live.loadError, shown.url)}
        onReload={page.reload}
      />
    );
  else if (live && shown && !blank && page.frame)
    content = (
      <PageView
        source={source}
        threadId={threadId}
        view={live}
        tab={shown}
        frame={page.frame}
        interactive={online}
        nativeShown={native.shown}
        fit={!tools.toolbar}
        framed={tools.toolbar}
        zoom={shown.zoom}
        cursor={pageCursor}
        onDropFiles={(files, at) => void browser.dropFiles(shown.tabId, files, at)}
        menu={chrome.menu}
        dimmed={!online || live.status === "paused"}
      />
    );
  else if (!online) content = <Offline />;
  else if (page.loading || unopened || (live && shown && !blank && !page.frame))
    content = <Opening download={page.download} />;
  else content = <StartPage suggestions={page.suggestions} disabled={offline} onGo={page.go} />;

  return (
    <div
      ref={root}
      data-browser-tab=""
      className="relative flex h-full min-h-0 flex-col"
      onKeyDownCapture={onKeyDown}
      {...drop.handlers}
    >
      {drop.indicator}
      <PageToolbar
        nav={
          <PageNav
            back={{ onClick: page.back, keys: "mod+[", disabled: !online || !page.canBack }}
            forward={{
              onClick: page.forward,
              keys: "mod+]",
              disabled: !online || !page.canForward,
            }}
            reload={{ onClick: page.reload, keys: "mod+r", disabled: !online || blank }}
            stop={{ onClick: page.stop, disabled: !shown }}
            loading={page.loading}
            after={
              <AnnotateButton
                source={source}
                threadId={threadId}
                online={online}
                page={
                  live && shown && !blank && !page.loading && page.state.phase !== "failed"
                    ? { ...live, url: shown.url, tabId: shown.tabId }
                    : undefined
                }
              />
            }
          />
        }
        address={
          <AddressBar
            url={blank ? undefined : shownUrl}
            known={page.suggestions}
            loading={page.loading}
            disabled={offline}
            placeholder="Search or enter a URL"
            onGo={page.go}
            lead={<ConnectionMark url={blank ? undefined : shownUrl} />}
            trail={
              <>
                <ZoomBadge tools={tools} />
                {live?.permissionDenied && (
                  <Tip
                    label={`Site access blocked: ${permissionLabel(live.permissionDenied.permission)}. Open the page in your browser to allow it.`}
                  >
                    <span
                      role="status"
                      aria-label={`Site access blocked: ${permissionLabel(live.permissionDenied.permission)}`}
                      className="grid size-6 place-items-center text-muted-foreground"
                    >
                      <WarningCircleIcon aria-hidden size={14} />
                    </span>
                  </Tip>
                )}
              </>
            }
          />
        }
        actions={
          <>
            <RecordingIndicator source={source} threadId={threadId} view={live} />
            {watch.watching !== undefined && <WatchButton {...watch} />}
            <SpeakerButton source={source} threadId={threadId} frame={page.frame} />
            <ToolPill>
              {!extensionsOff && (
                <ExtensionsMenu
                  source={source}
                  threadId={threadId}
                  backend={live?.backend}
                  online={online}
                />
              )}
              <DownloadsButton
                threadId={threadId}
                downloads={live?.downloads ?? []}
                open={chrome.downloads.open}
                onOpenChange={chrome.downloads.setOpen}
              />
            </ToolPill>
            <BrowserActions
              threadId={threadId}
              tab={shown}
              shownUrl={blank ? undefined : shownUrl}
              external={external}
              online={online}
              browser={browser}
              tools={tools}
              actions={chrome.actions}
              onFind={() => setFinding(true)}
              onDownloads={() => chrome.downloads.setOpen(true)}
              onHistory={chrome.openHistory}
              onClearData={chrome.openClearData}
              onSettings={chrome.openSettings}
              onKeepPrivate={(value) => shown && tabs.keepPrivate(shown.tabId, value)}
              onCloseTab={() => shown && tabs.close(shown.tabId)}
              drawer={drawer !== undefined}
              onDrawer={(open) => page.save({ drawer: open ? "console" : undefined })}
              onScreenshotSizes={() => setSizing(true)}
              watching={watch.watching}
              onWatch={watch.toggle}
              splitWith={
                pane || !ownId
                  ? undefined
                  : tabs.tabs
                      .filter((tab) => tab.tabId !== ownId)
                      .map((tab) => ({ tabId: tab.tabId, title: tab.title || tab.url }))
              }
              onSplit={(other) => ownId && openSplit(threadId, ownId, other)}
              onLeaveSplit={pane?.onLeave}
            />
          </>
        }
        progress={page.loading ? `Loading ${displayAddress(shownUrl ?? "")}` : undefined}
      />
      {tools.toolbar && <DeviceToolbar tools={tools} />}
      {live && !live.closed && <PageDialog view={live} browser={browser} />}
      {live && !live.closed && <PageSignIn view={live} browser={browser} />}
      {live && !live.closed && <PageFileChooser view={live} browser={browser} />}
      {finding && live && (
        <FindPage
          source={source}
          threadId={threadId}
          tabId={shown?.tabId}
          onClose={() => setFinding(false)}
        />
      )}
      <div
        ref={pageArea}
        data-browser-page=""
        className={cn(
          "relative min-h-0 flex-1 overflow-auto",
          live && page.frame && "overflow-hidden",
        )}
      >
        {tools.toolbar ? (
          <DeviceStage tools={tools} frame={deviceFrame}>
            {content}
            {still && <CoverPicture still={still} />}
          </DeviceStage>
        ) : (
          <>
            {content}
            {still && <CoverPicture still={still} />}
          </>
        )}
      </div>
      {chrome.dialogs}
      {sizing && shown && (
        <ResponsiveScreenshotDialog
          source={source}
          threadId={threadId}
          tabId={shown.tabId}
          onClose={() => setSizing(false)}
        />
      )}
      {drawer && shown && (
        <ConsoleDrawer
          source={source}
          threadId={threadId}
          tabId={shown.tabId}
          section={drawer}
          onSection={(section) => page.save({ drawer: section })}
          height={drawerHeight ?? page.data.drawerHeight ?? drawerHeights.initial}
          onHeight={(height, persist) => {
            setDrawerHeight(persist ? undefined : height);
            if (persist) page.save({ drawerHeight: height });
          }}
          onClose={() => page.save({ drawer: undefined })}
        />
      )}
    </div>
  );
}

/** One tab, or the two of a split view this tab is part of. */
function BrowserOrSplit(props: TabViewProps) {
  const own = daemonTabId(props.tab);
  const split = useLocal(splits, (all) => all.get(props.scope));
  if (split && own && (split.left === own || split.right === own))
    return (
      <SplitBrowser
        threadId={props.scope}
        split={split}
        from={own}
        render={(tab, pane) => <Browser {...props} key={tab.key} tab={tab} pane={pane} />}
      />
    );
  return <Browser {...props} />;
}

export default function BrowserTab(props: TabViewProps) {
  return (
    <WithServices>
      <BrowserOrSplit {...props} />
    </WithServices>
  );
}
