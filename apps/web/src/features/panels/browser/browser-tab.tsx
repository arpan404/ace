import { desktopBrowserViews, type BrowserAccelerator } from "@/boot/desktop-browser.ts";
import { displayAddress } from "@ace/ui-core";
import { useEffectEvent, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/cn.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { reportBrowserControl } from "@/lib/browser-control.ts";
import { usePanelServices } from "../services.ts";
import { WithServices } from "../with-services.tsx";
import { FindPage } from "./find-page.tsx";
import { AddressBar } from "./address-bar.tsx";
import { AgentTabs } from "./agent-tabs.tsx";
import { ControlStrip, useControl } from "./control-strip.tsx";
import { PageDialog } from "./page-dialog.tsx";
import { useBrowserFeatures } from "./use-browser-features.ts";
import { BrowserActions } from "./browser-actions.tsx";
import { PageNav, PageToolbar } from "./page-toolbar.tsx";
import { useNativeView } from "./native-view.ts";
import { LoadFailed, Offline, Opening, Parked, Reopen, StartPage } from "./page-states.tsx";
import { PageView } from "./page-view.tsx";
import { useBrowserTab } from "./use-browser-tab.ts";
import { viewportById } from "./viewports.ts";

/**
 * A browser tab: an editable address over the thread's live page, with Back, Forward, Reload,
 * the control lease, device sizes and opening the page in this device's own browser. The page
 * fills the panel on ace's own surface; a failed load keeps its address with Reload; a tab whose
 * address isn't the live page's offers to load it here.
 */
function Browser(props: TabViewProps) {
  const [finding, setFinding] = useState(false);
  const threadId = props.scope;
  const { preview: source } = usePanelServices();
  const page = useBrowserTab(source, threadId, props.tab);
  const actions = useWorkspaceActions(threadId);
  const toast = useToast();
  const control = useControl(source, threadId, page.live);
  const browser = useBrowserFeatures(source, threadId);
  // The rail's indicator: an agent drives this page, or it is held privately.
  const live = page.live;
  const reported = live && {
    threadId,
    url: live.url,
    controller: live.controller,
    private: live.takeoverMode === "private",
  };
  const reportKey = reported
    ? `${reported.url}|${reported.controller}|${String(reported.private)}`
    : undefined;
  useEffect(() => {
    reportBrowserControl(threadId, reported || undefined);
    // The key says when the report changed; the object is rebuilt every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, reportKey]);
  useEffect(() => () => reportBrowserControl(threadId, undefined), [threadId]);
  const loading = page.state.phase === "loading";
  const viewport = viewportById(page.data.viewport);
  const shownUrl =
    page.state.phase === "idle" ? (page.bound ? page.live?.url : page.data.url) : page.state.url;
  const offline = page.online ? undefined : "The daemon is offline";
  const external = shownUrl && /^https?:\/\//i.test(shownUrl) ? shownUrl : undefined;
  useHotkey(keymap.takeControl.keys, control.toggle, { enabled: page.bound });
  // In the desktop app the page itself is a native view drawn over this tab's page area.
  const pageArea = useRef<HTMLDivElement>(null);
  useNativeView(
    threadId,
    pageArea,
    page.bound &&
      page.live?.backend === "embedded" &&
      page.live.status !== "paused" &&
      page.live.status !== "recovering" &&
      page.online &&
      page.state.phase !== "failed",
    {
      device: viewport.emulation,
      owner: page.heldAs,
      // A click on the page while an agent drives it takes control the way the button does;
      // the page takes input only once the daemon has granted it. Another device's control
      // isn't taken away.
      onWantsControl: () => {
        if (page.live && page.live.controller !== "human") control.toggle();
      },
    },
  );

  const root = useRef<HTMLDivElement>(null);
  const shortcut = (accelerator: BrowserAccelerator) => {
    if (accelerator === "CmdOrCtrl+L")
      root.current?.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.focus();
    else if (accelerator === "CmdOrCtrl+F") setFinding(true);
    else if (accelerator === "CmdOrCtrl+R") page.reload();
    else if (accelerator === "CmdOrCtrl+[") page.back();
    else page.forward();
  };
  const nativeShortcut = useEffectEvent((id: string, accelerator: BrowserAccelerator) => {
    if (id === threadId) shortcut(accelerator);
  });
  useEffect(() => desktopBrowserViews()?.onShortcut(nativeShortcut), [threadId]);

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
    if (!page.live) {
      page.save({ viewport: next.id });
      return;
    }
    const apply = async () => {
      if (!source.heldAs(threadId)) await source.takeover(threadId);
      // Back to the panel's size: the viewport follows the pane again from the next layout.
      await source.emulate(
        threadId,
        next.emulation ?? {
          width: 800,
          height: 600,
          deviceScaleFactor: 1,
          mobile: false,
          touch: false,
        },
      );
      page.save({ viewport: next.id });
    };
    apply().catch((error: unknown) =>
      toast.add({
        title: "Couldn't change the page size",
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  };

  let content;
  if (page.state.phase === "failed")
    content = (
      <LoadFailed url={page.state.url} failure={page.state.failure} onReload={page.reload} />
    );
  else if (page.bound && page.live && page.frame)
    content = (
      <PageView
        source={source}
        threadId={threadId}
        view={page.live}
        frame={page.frame}
        interactive={!!page.heldAs && page.online}
        fit={viewport.emulation === undefined}
        dimmed={!page.online || page.live.status === "paused"}
      />
    );
  else if (!page.online) content = <Offline />;
  else if (loading || (page.bound && page.live && !page.frame))
    content = <Opening download={page.download} />;
  else if (page.live && !page.bound && page.data.url && page.owner)
    content = (
      <Parked
        url={page.data.url}
        liveUrl={page.live.url}
        onShowHere={() => page.data.url && page.go(page.data.url)}
        onGoToTab={() => page.owner && actions.activate(page.owner)}
      />
    );
  else if (page.data.url && !page.bound)
    content = (
      <Reopen
        url={page.data.url}
        liveUrl={page.live?.url}
        disabled={offline}
        onReopen={() => page.data.url && page.go(page.data.url)}
      />
    );
  else content = <StartPage suggestions={page.suggestions} disabled={offline} onGo={page.go} />;

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col" onKeyDownCapture={onKeyDown}>
      <PageToolbar
        nav={
          <PageNav
            back={{
              onClick: page.back,
              keys: "mod+[",
              reason: !page.online
                ? "the daemon is offline"
                : page.canBack
                  ? undefined
                  : "no earlier page in this tab",
            }}
            forward={{
              onClick: page.forward,
              keys: "mod+]",
              reason: !page.online
                ? "the daemon is offline"
                : page.canForward
                  ? undefined
                  : "no later page in this tab",
            }}
            reload={{
              onClick: page.reload,
              keys: "mod+r",
              reason: !page.online
                ? "the daemon is offline"
                : shownUrl
                  ? undefined
                  : "open a page first",
            }}
            loading={loading}
          />
        }
        address={
          <AddressBar
            url={shownUrl}
            known={page.suggestions}
            loading={loading}
            disabled={offline}
            hint={
              page.live?.controller === "agent"
                ? "Going to an address takes control of the page from the agent"
                : undefined
            }
            autoFocus={!props.tab.data}
            onGo={page.go}
          />
        }
        actions={
          <BrowserActions
            source={source}
            threadId={threadId}
            shownUrl={shownUrl}
            external={external}
            viewport={viewport}
            onViewport={setViewport}
            live={!!page.live}
            online={page.online}
            backend={page.live?.backend}
            browser={browser}
            onFind={() => setFinding(true)}
            downloads={page.live?.downloads ?? []}
            privately={page.live?.takeoverMode === "private"}
          />
        }
        progress={loading ? `Loading ${displayAddress(shownUrl ?? "")}` : undefined}
      />
      {page.bound && page.live && (
        <ControlStrip
          view={page.live}
          heldHere={!!page.heldAs}
          busy={control.busy}
          onToggle={control.toggle}
          onPrivate={control.takePrivately}
        />
      )}
      {page.live && !page.live.closed && (
        <>
          <AgentTabs view={page.live} browser={browser} busy={control.busy} />
          <PageDialog view={page.live} browser={browser} />
        </>
      )}
      {finding && page.live && (
        <FindPage source={source} threadId={threadId} onClose={() => setFinding(false)} />
      )}
      <div
        ref={pageArea}
        data-browser-page=""
        className={cn(
          "relative min-h-0 flex-1 overflow-auto",
          page.bound && page.frame && "overflow-hidden",
        )}
      >
        {content}
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
