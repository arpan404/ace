import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowSquareOutIcon,
  DevicesIcon,
  DotsThreeIcon,
  XIcon,
} from "@phosphor-icons/react";
import { displayAddress } from "@ace/ui-core";
import { useState, type KeyboardEvent } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { Dot } from "@/components/ui/dot.tsx";
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
import { Spinner } from "@/components/ui/spinner.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useHotkey } from "@/lib/hotkeys.ts";
import { keymap } from "@/lib/keymap.ts";
import { useWorkspaceActions, type TabViewProps } from "@/lib/workspace/index.ts";
import { useBrowserDriver } from "../preview/use-browser-driver.ts";
import { usePanelServices } from "../services.ts";
import type { BrowserView, PreviewSource } from "../sources.ts";
import { WithServices } from "../with-services.tsx";
import { AddressBar } from "./address-bar.tsx";
import { bindPage } from "./loading.ts";
import { LoadFailed, Offline, Opening, Parked, StartPage } from "./page-states.tsx";
import { PageView } from "./page-view.tsx";
import { useBrowserTab } from "./use-browser-tab.ts";
import { viewportById, viewports } from "./viewports.ts";

const tool = "size-7 rounded-[7px]";

/** Who has the page: the agent (named from the thread's tree), this device, or nobody yet. */
function ControlStrip(props: { view: BrowserView; busy: boolean; onToggle(): void }) {
  const driver = useBrowserDriver(props.view.threadId);
  const { view } = props;
  let text;
  let mark;
  if (view.status === "paused" || view.status === "recovering") {
    mark = view.status === "recovering" ? <Spinner /> : <Dot tone="needs-you" />;
    text = (
      <>
        {view.status === "recovering" ? "Reconnecting the browser" : "The browser is paused"}
        {view.reason && ` · ${view.reason}`}
      </>
    );
  } else if (view.controller === "human") {
    mark = <Dot tone="needs-you" />;
    text = (
      <>
        <b className="font-medium text-foreground">You</b> have control · agents wait until you hand
        it back
      </>
    );
  } else {
    mark = <Spinner className="text-status-working" />;
    text = (
      <>
        <b className="font-medium text-foreground">{driver ?? "An agent"}</b> is using this page
      </>
    );
  }
  return (
    <div
      role="status"
      className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground"
    >
      {mark}
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {view.pageStateLost && (
        <span className="shrink-0 text-subtle-foreground">
          Reopened after the browser was lost; sign-ins were reset
        </span>
      )}
      {view.status !== "paused" && view.status !== "recovering" && (
        <Tip label={keymap.takeControl.label} shortcut="takeControl">
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onToggle}
            className="h-6 shrink-0 rounded-[7px] px-2 font-medium text-foreground outline-none hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)] disabled:opacity-50"
          >
            {view.controller === "human" ? "Hand back" : "Take control"}
          </button>
        </Tip>
      )}
    </div>
  );
}

function useControl(source: PreviewSource, threadId: string, view: BrowserView | undefined) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = () => {
    if (busy || !view) return;
    setBusy(true);
    const human = view.controller === "human";
    (human ? source.handback(threadId) : source.takeover(threadId))
      .catch((error: unknown) =>
        toast.add({
          title: human ? "Couldn't hand back control" : "Couldn't take control",
          description: error instanceof Error ? error.message : undefined,
        }),
      )
      .finally(() => setBusy(false));
  };
  return { busy, toggle };
}

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
  const loading = page.state.phase === "loading";
  const viewport = viewportById(page.data.viewport);
  const shownUrl =
    page.state.phase === "idle" ? (page.bound ? page.live?.url : page.data.url) : page.state.url;
  const offline = page.online ? undefined : "The daemon is offline";
  const external = shownUrl && /^https?:\/\//i.test(shownUrl) ? shownUrl : undefined;
  useHotkey(keymap.takeControl.keys, control.toggle, { enabled: page.bound });

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
  else content = <StartPage suggestions={page.suggestions} disabled={offline} onGo={page.go} />;

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDownCapture={onKeyDown}>
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex shrink-0 items-center">
          <IconButton
            icon={ArrowLeftIcon}
            label={page.canBack ? "Back" : "Back · no earlier page in this tab"}
            keys="mod+["
            disabled={!page.canBack || !page.online}
            className={tool}
            onClick={page.back}
          />
          <IconButton
            icon={ArrowRightIcon}
            label={page.canForward ? "Forward" : "Forward · no later page in this tab"}
            keys="mod+]"
            disabled={!page.canForward || !page.online}
            className={tool}
            onClick={page.forward}
          />
          {loading ? (
            <IconButton
              icon={XIcon}
              label="Stop · the browser relay can't cancel a load yet; it gives up after 30 seconds"
              disabled
              focusableWhenDisabled
              className={tool}
            />
          ) : (
            <IconButton
              icon={ArrowClockwiseIcon}
              label="Reload"
              keys="mod+r"
              disabled={!shownUrl || !page.online}
              className={tool}
              onClick={page.reload}
            />
          )}
        </div>
        <AddressBar
          className="mx-auto w-full max-w-[768px] flex-1"
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
        <div className="flex shrink-0 items-center gap-0.5">
          <Menu>
            <Tip label={`Page size · ${viewport.label}`}>
              <MenuTrigger
                aria-label="Page size"
                className="grid size-7 place-items-center rounded-[7px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-accent aria-expanded:text-foreground"
              >
                <DevicesIcon
                  aria-hidden
                  size={16}
                  weight={viewport.emulation ? "fill" : "regular"}
                />
              </MenuTrigger>
            </Tip>
            <MenuContent align="end">
              <MenuRadioGroup
                value={viewport.id}
                onValueChange={(value) => setViewport(String(value))}
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
            label={
              external ? "Open in your browser" : "Open in your browser · open a web page first"
            }
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
              className="grid size-7 place-items-center rounded-[7px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-accent aria-expanded:text-foreground"
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
                disabled={!page.live || !page.online}
                reason={page.live ? undefined : "No page is open"}
                onClick={() => {
                  bindPage(threadId, undefined);
                  void source.close(threadId).catch(() => undefined);
                }}
              >
                Close the thread's page
              </MenuItem>
              <MenuSeparator />
              <p className="px-2.5 py-1.5 text-xs leading-4 text-subtle-foreground">
                {page.live?.backend === "embedded"
                  ? "Runs in the ace desktop app's browser."
                  : page.live?.backend === "headless"
                    ? "Runs in ace's own Chromium on the daemon's machine."
                    : "Pages open in ace's own browser, never your personal one."}
              </p>
            </MenuContent>
          </Menu>
        </div>
        {loading && (
          <span
            role="progressbar"
            aria-label={`Loading ${displayAddress(shownUrl ?? "")}`}
            className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
          >
            <span className="fx-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-[color-mix(in_oklab,var(--ring)_80%,transparent)]" />
          </span>
        )}
      </div>
      {page.bound && page.live && (
        <ControlStrip view={page.live} busy={control.busy} onToggle={control.toggle} />
      )}
      <div
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
