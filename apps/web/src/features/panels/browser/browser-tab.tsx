import { ArrowSquareOutIcon, DevicesIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { displayAddress } from "@ace/ui-core";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { openExternal, revealer } from "@/boot/open-external.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { reportBrowserControl } from "@/lib/browser-control.ts";
import { usePanelServices } from "../services.ts";
import { useLocal } from "../store.ts";
import type { BrowserView, PreviewSource } from "../sources.ts";
import { WithServices } from "../with-services.tsx";
import { AddressBar } from "./address-bar.tsx";
import { AgentTabs } from "./agent-tabs.tsx";
import { ControlStrip, useControl } from "./control-strip.tsx";
import { DownloadsButton } from "./downloads.tsx";
import { PageDialog } from "./page-dialog.tsx";
import { SiteAccess } from "./site-access.tsx";
import {
  recordingThreads,
  useBrowserFeatures,
  type BrowserFeatures,
} from "./use-browser-features.ts";
import { PageNav, PageToolbar } from "./page-toolbar.tsx";
import { bindPage } from "./loading.ts";
import { useNativeView } from "./native-view.ts";
import { LoadFailed, Offline, Opening, Parked, Reopen, StartPage } from "./page-states.tsx";
import { PageView } from "./page-view.tsx";
import { useBrowserTab } from "./use-browser-tab.ts";
import { viewportById, viewports } from "./viewports.ts";

const tool = "size-7 rounded-sm";

/**
 * A browser tab: an editable address over the thread's live page, with Back, Forward, Reload,
 * the control lease, device sizes and opening the page in this device's own browser. The page
 * fills the panel on ace's own surface; a failed load keeps its address with Reload; a tab whose
 * address isn't the live page's offers to load it here.
 */
function Browser(props: TabViewProps) {
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "l")
      event.currentTarget.querySelector<HTMLInputElement>('input[aria-label="Address"]')?.focus();
    else if (key === "r" && !event.shiftKey) page.reload();
    else if (event.code === "BracketLeft" && !event.shiftKey) page.back();
    else if (event.code === "BracketRight" && !event.shiftKey) page.forward();
    else return;
    // The tab's own browser keys win over the app's (⌘[ is app Back elsewhere).
    event.preventDefault();
    event.stopPropagation();
  };

  const setViewport = (id: string) => {
    const next = viewportById(id);
    page.save({ viewport: next.id });
    if (!page.live) return;
    const apply = async () => {
      if (source.view(threadId)?.controller !== "human") await source.takeover(threadId);
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
        interactive={page.live.controller === "human" && page.online}
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
    <div className="flex h-full min-h-0 flex-col" onKeyDownCapture={onKeyDown}>
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
            downloads={page.live?.downloads ?? []}
            privately={page.live?.takeoverMode === "private"}
          />
        }
        progress={loading ? `Loading ${displayAddress(shownUrl ?? "")}` : undefined}
      />
      {page.bound && page.live && (
        <ControlStrip
          view={page.live}
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

/** Page size, Open in your browser and the options menu: the browser page's toolbar actions. */
function BrowserActions(props: {
  source: PreviewSource;
  threadId: string;
  shownUrl: string | undefined;
  external: string | undefined;
  viewport: ReturnType<typeof viewportById>;
  onViewport(id: string): void;
  live: boolean;
  online: boolean;
  backend: BrowserView["backend"] | undefined;
  browser: BrowserFeatures;
  downloads: NonNullable<BrowserView["downloads"]>;
  privately: boolean;
}) {
  const toast = useToast();
  const { shownUrl, external, viewport, browser } = props;
  const recording = useLocal(recordingThreads, (threads) => threads.has(props.threadId));
  const setRecording = (on: boolean) =>
    recordingThreads.set((threads) => {
      const next = new Set(threads);
      if (on) next.add(props.threadId);
      else next.delete(props.threadId);
      return next;
    });
  const toggleRecording = async () => {
    if (!recording) {
      if (await browser.startRecording()) setRecording(true);
      return;
    }
    const artifact = await browser.stopRecording();
    setRecording(false);
    if (!artifact) return;
    const reveal = revealer();
    toast.add({
      title: "Recording saved to this thread",
      description: artifact.filename ?? artifact.path,
      ...(reveal
        ? {
            actionProps: {
              children: "Show in Finder",
              onClick: () => void reveal(artifact.path).catch(() => {}),
            },
          }
        : {}),
    });
  };
  return (
    <>
      <DownloadsButton downloads={props.downloads} />
      <SiteAccess threadId={props.threadId} browser={browser} />
      <Menu>
        <Tip label={`Page size · ${viewport.label}`}>
          <MenuTrigger
            aria-label="Page size"
            className="grid size-7 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-ring aria-expanded:bg-accent aria-expanded:text-foreground"
          >
            <DevicesIcon aria-hidden size={16} weight={viewport.emulation ? "fill" : "regular"} />
          </MenuTrigger>
        </Tip>
        <MenuContent align="end">
          <MenuRadioGroup
            value={viewport.id}
            onValueChange={(value) => props.onViewport(String(value))}
          >
            {viewports.map((each) => (
              <MenuRadioItem key={each.id} value={each.id}>
                {each.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <IconButton
        icon={ArrowSquareOutIcon}
        label={external ? "Open in your browser" : "Open in your browser · open a web page first"}
        disabled={!external}
        className={tool}
        onClick={() =>
          external &&
          void openExternal(external).catch((error: unknown) =>
            toast.add({
              title: "Couldn't open the page",
              description: error instanceof Error ? error.message : undefined,
            }),
          )
        }
      />
      <Menu>
        <MenuTrigger
          aria-label="Browser options"
          className="grid size-7 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-ring aria-expanded:bg-accent aria-expanded:text-foreground"
        >
          <DotsThreeIcon aria-hidden size={16} weight="bold" />
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem
            disabled={!shownUrl}
            onClick={() =>
              shownUrl &&
              void navigator.clipboard?.writeText(shownUrl).then(
                () => toast.add({ title: "Address copied" }),
                () => toast.add({ title: "Couldn't copy the address" }),
              )
            }
          >
            Copy address
          </MenuItem>
          <MenuItem
            danger
            disabled={!props.live || !props.online}
            reason={props.live ? undefined : "No page is open"}
            onClick={() => {
              bindPage(props.threadId, undefined);
              void props.source.close(props.threadId).catch(() => undefined);
            }}
          >
            Close the thread's page
          </MenuItem>
          <MenuItem
            disabled={!props.live || !props.online || (props.privately && !recording)}
            reason={
              props.privately && !recording
                ? "Private pages are never recorded"
                : props.live
                  ? undefined
                  : "No page is open"
            }
            onClick={() => void toggleRecording()}
          >
            {recording ? "Stop recording" : "Record the page"}
          </MenuItem>
          <MenuSeparator />
          <p className="px-2.5 py-1.5 text-xs leading-4 text-subtle-foreground">
            {props.backend === "embedded"
              ? "Runs in the ace desktop app's browser."
              : props.backend === "headless"
                ? "Runs in ace's own Chromium on the daemon's machine."
                : "Pages open in ace's own browser, never your personal one."}
          </p>
        </MenuContent>
      </Menu>
    </>
  );
}

export default function BrowserTab(props: TabViewProps) {
  return (
    <WithServices>
      <Browser {...props} />
    </WithServices>
  );
}
