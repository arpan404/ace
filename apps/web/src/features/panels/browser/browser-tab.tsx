import { desktopBrowserViews, type BrowserAccelerator } from "@/boot/desktop-browser.ts";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { displayAddress, describeBrowserFailure } from "@ace/ui-core";
import { useEffectEvent, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { type TabViewProps } from "@/lib/workspace/index.ts";
import { reportBrowserControl } from "@/lib/browser-control.ts";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import { WithServices } from "../with-services.tsx";
import { FindPage } from "./find-page.tsx";
import { AddressBar } from "./address-bar.tsx";
import { PageDialog } from "./page-dialog.tsx";
import { PageSignIn } from "./page-sign-in.tsx";
import { useBrowserFeatures } from "./use-browser-features.ts";
import { BrowserActions } from "./browser-actions.tsx";
import { DownloadsButton } from "./downloads.tsx";
import { ExtensionsMenu, extensionsHidden } from "./extensions-menu.tsx";
import { PageNav, PageToolbar, ToolPill } from "./page-toolbar.tsx";
import { PageTabs } from "./page-tabs.tsx";
import { AnnotateButton } from "./annotate-button.tsx";
import { useNativeView } from "./native-view.ts";
import {
  CertificateWarning,
  Disconnected,
  LoadFailed,
  Offline,
  Opening,
  StartPage,
} from "./page-states.tsx";
import { PageView } from "./page-view.tsx";
import { ConnectionMark } from "./connection-mark.tsx";
import { useBrowserTab } from "./use-browser-tab.ts";
import { useBrowserTabs } from "./use-browser-tabs.ts";
import { viewportById } from "./viewports.ts";

const permissionLabel = (permission: string) =>
  ({
    media: "camera or microphone",
    geolocation: "location",
    notifications: "notifications",
    "clipboard-sanitized-write": "clipboard",
  })[permission] ?? "a site permission";

/**
 * The thread's browser: the strip of its tabs (the person's and every agent's, the same on
 * every device), the shown tab's toolbar and the page itself. The person and agents share every
 * tab: anyone can click, type or navigate anywhere at any time, and an agent's work shows as its
 * cursor on the tab and over the page. The page fills the panel on ace's own surface (or the
 * desktop's native view); a failed load keeps its address with Reload.
 */
function Browser(props: TabViewProps) {
  const [finding, setFinding] = useState(false);
  const threadId = props.scope;
  const { preview: source } = usePanelServices();
  const browser = useBrowserFeatures(threadId);
  const tabs = useBrowserTabs(source, threadId);
  const page = useBrowserTab(source, threadId, props.tab, tabs);
  const toast = useToast();
  const extensionsOff = useLocal(extensionsHidden, (value) => value);
  const { live, shown, online } = tabs;

  // The rail's indicator: an agent works in this thread's browser, or the shown tab is private.
  const working = tabs.tabs.some((tab) => tab.inUse !== undefined);
  const privately = shown?.private === true;
  useEffect(() => {
    reportBrowserControl(
      threadId,
      live ? { threadId, url: live.url, agent: working, private: privately } : undefined,
    );
  }, [threadId, live, working, privately]);
  useEffect(() => () => reportBrowserControl(threadId, undefined), [threadId]);

  const viewport = viewportById(page.data.viewport);
  const shownUrl = page.shownUrl;
  const blank = !shownUrl || shownUrl === "about:blank";
  const offline = online ? undefined : "ace is offline";
  const external = shownUrl && /^https?:\/\//i.test(shownUrl) ? shownUrl : undefined;
  // In the desktop app the page itself is a native view drawn over this tab's page area.
  const pageArea = useRef<HTMLDivElement>(null);
  const native = useNativeView(
    threadId,
    pageArea,
    !!live &&
      !blank &&
      live.backend === "embedded" &&
      live.status !== "paused" &&
      live.status !== "recovering" &&
      online &&
      page.state.phase !== "failed" &&
      !shown?.certificateError,
    { device: viewport.emulation },
  );
  const nativeShown = native.shown || native.frozen !== undefined;

  useEffect(() => {
    source.nativeShown?.(threadId, nativeShown);
    return () => source.nativeShown?.(threadId, !!desktopBrowserViews());
  }, [source, threadId, nativeShown]);

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
  const shortcut = (accelerator: BrowserAccelerator) => {
    if (accelerator === "CmdOrCtrl+L") focusAddress();
    else if (accelerator === "CmdOrCtrl+F") setFinding(true);
    else if (accelerator === "CmdOrCtrl+R") page.reload();
    else if (accelerator === "CmdOrCtrl+T") void tabs.newTab().then(focusAddress);
    else if (accelerator === "CmdOrCtrl+[") page.back();
    else page.forward();
  };
  const nativeShortcut = useEffectEvent((id: string, accelerator: BrowserAccelerator) => {
    if (id === threadId) shortcut(accelerator);
  });
  useEffect(() => desktopBrowserViews()?.onShortcut(nativeShortcut), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "l") shortcut("CmdOrCtrl+L");
    else if (key === "f" && !event.shiftKey) shortcut("CmdOrCtrl+F");
    else if (key === "r" && !event.shiftKey) shortcut("CmdOrCtrl+R");
    else if (event.code === "BracketLeft" && !event.shiftKey) shortcut("CmdOrCtrl+[");
    else if (event.code === "BracketRight" && !event.shiftKey) shortcut("CmdOrCtrl+]");
    else return;
    // The tab's own browser keys win over the app's (⌘[ is app Back elsewhere).
    event.preventDefault();
    event.stopPropagation();
  };

  const setViewport = (id: string) => {
    const next = viewportById(id);
    if (!live || !shown) {
      page.save({ viewport: next.id });
      return;
    }
    // Back to the panel's size: the viewport follows the pane again from the next layout.
    source
      .emulate(
        threadId,
        next.emulation ?? {
          width: Math.max(100, Math.round(pageArea.current?.clientWidth ?? 800)),
          height: Math.max(100, Math.round(pageArea.current?.clientHeight ?? 600)),
          deviceScaleFactor: 1,
          mobile: false,
          touch: false,
        },
        shown.tabId,
      )
      .then(() => page.save({ viewport: next.id }))
      .catch((error: unknown) =>
        toast.error({
          title: "Couldn't change the page size",
          description: error instanceof Error ? error.message : undefined,
        }),
      );
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
        nativeShown={nativeShown}
        fit={viewport.emulation === undefined}
        dimmed={!online || live.status === "paused"}
      />
    );
  else if (!online) content = <Offline />;
  else if (page.loading || (live && shown && !blank && !page.frame))
    content = <Opening download={page.download} />;
  else content = <StartPage suggestions={page.suggestions} disabled={offline} onGo={page.go} />;

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" onKeyDownCapture={onKeyDown}>
      {live && tabs.tabs.length > 0 && (
        <PageTabs
          threadId={threadId}
          tabs={tabs.tabs}
          shownId={tabs.shownId}
          onSelect={tabs.select}
          onClose={tabs.close}
          onMute={(tabId, muted) => void browser.muteTab(tabId, muted)}
          onNew={() => void tabs.newTab().then(focusAddress)}
        />
      )}
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
                    ? { ...live, url: shown.url }
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
            autoFocus={blank}
            onGo={page.go}
            lead={<ConnectionMark url={blank ? undefined : shownUrl} />}
            trail={
              live?.permissionDenied && (
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
              )
            }
          />
        }
        actions={
          <>
            <ToolPill>
              {!extensionsOff && (
                <ExtensionsMenu
                  source={source}
                  threadId={threadId}
                  backend={live?.backend}
                  online={online}
                />
              )}
              <DownloadsButton downloads={live?.downloads ?? []} />
            </ToolPill>
            <BrowserActions
              threadId={threadId}
              tab={shown}
              shownUrl={blank ? undefined : shownUrl}
              external={external}
              viewport={viewport}
              onViewport={setViewport}
              online={online}
              browser={browser}
              onFind={() => setFinding(true)}
              onKeepPrivate={(value) => shown && tabs.keepPrivate(shown.tabId, value)}
              onCloseTab={() => shown && tabs.close(shown.tabId)}
            />
          </>
        }
        progress={page.loading ? `Loading ${displayAddress(shownUrl ?? "")}` : undefined}
      />
      {live && !live.closed && <PageDialog view={live} browser={browser} />}
      {live && !live.closed && <PageSignIn view={live} browser={browser} />}
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
        {content}
        {native.frozen && (
          // The native page's picture, exactly where the page is, while a menu covers it.
          <img
            data-frozen-page=""
            src={native.frozen.src}
            alt=""
            aria-hidden
            draggable={false}
            style={{
              left: native.frozen.box.x,
              top: native.frozen.box.y,
              width: native.frozen.box.width,
              height: native.frozen.box.height,
            }}
            className="pointer-events-none absolute max-w-none select-none"
          />
        )}
      </div>
    </div>
  );
}

export default function BrowserTab(props: TabViewProps) {
  return (
    <WithServices>
      <Browser {...props} />
    </WithServices>
  );
}
