import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { desktopBrowserViews, type BrowserContextAction } from "@/boot/desktop-browser.ts";
import { useToast } from "@/components/ui/toast.tsx";
import { windowsPlatform } from "@/lib/keymap.ts";
import type { BrowserTabView, BrowserView, ForwardedInput, PreviewSource } from "../sources.ts";
import { requestAnnotate } from "./annotate-request.ts";
import { useBrowsingHistory } from "./browsing-history.ts";
import { HistoryDialog } from "./history-dialog.tsx";
import { ClearDataDialog, PageSourceDialog } from "./page-dialogs.tsx";
import type { PageMenu } from "./page-context-menu.tsx";
import { pageKey, type PageKey } from "./page-keys.ts";
import { usePageActions } from "./use-page-actions.ts";
import { usePageTarget } from "./use-page-target.ts";
import type { PageTools } from "./use-page-tools.ts";
import { reason } from "./use-browser-features.ts";
import { zoomIn, zoomOut } from "@ace/ui-core";

/** The page's history controls, as `useBrowserTab` gives them. */
interface PageNavigation {
  /** The address the person sees for the shown tab. */
  shownUrl: string | undefined;
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
  reload(): void;
  go(url: string): void;
}

/**
 * Everything around the shown tab's page that a browser has besides navigation: the device
 * toolbar and zoom (`usePageTools`), Print, screenshots, developer tools and page source
 * (`usePageActions`), History and Clear browsing data with their dialogs, the right-click
 * menu, and the browser keys for all of them, from the panel and from the desktop's native
 * page alike.
 */
export function usePageChrome(input: {
  source: PreviewSource;
  threadId: string;
  live: BrowserView | undefined;
  tab: BrowserTabView | undefined;
  nativeShown: boolean;
  page: PageNavigation;
  /** A new tab at `url`, shown at once. */
  openTab(url: string): Promise<unknown>;
  /** The tab's device toolbar and zoom (`usePageTools`). */
  tools: PageTools;
  /** ⌘L, ⌘F and the other keys the panel already answered before these tools. */
  onKey(key: "address" | "find" | "reload" | "back" | "forward"): void;
}) {
  const { source, threadId, live, tab, page } = input;
  const toast = useToast();
  const navigate = useNavigate();
  const { tools } = input;
  const actions = usePageActions({
    source,
    threadId,
    live,
    tab,
    nativeShown: input.nativeShown,
  });
  const history = useBrowsingHistory();
  const [historyAt, setHistoryAt] = useState<number>();
  const [clearing, setClearing] = useState(false);
  const [downloads, setDownloads] = useState(false);

  // Every page the tab shows the person goes into the thread's history (titles follow).
  const shownUrl = page.shownUrl;
  const shownTitle = tab?.title ?? "";
  useEffect(() => {
    if (shownUrl) history.record(threadId, { url: shownUrl, title: shownTitle }, Date.now());
  }, [history, threadId, shownUrl, shownTitle]);

  const openTab = (url: string) =>
    void input
      .openTab(url)
      .catch((error: unknown) =>
        toast.error({ title: "Couldn't open a new tab", description: reason(error) }),
      );

  const run = (key: PageKey) => {
    if (key === "zoomIn") tools.setZoom(zoomIn(tools.zoom));
    else if (key === "zoomOut") tools.setZoom(zoomOut(tools.zoom));
    else if (key === "zoomReset") tools.setZoom(1);
    else if (key === "print") actions.print();
    else if (key === "history") setHistoryAt(Date.now());
    else if (key === "devtools") actions.devtools();
    else if (key === "source") actions.viewSource();
    else input.onKey(key);
  };

  // The desktop's native page: its zoom keys and its context menu's picks come here.
  const nativeZoom = useEffectEvent((id: string, accelerator: string) => {
    if (id !== threadId || !tools.canZoom) return;
    if (accelerator === "CmdOrCtrl+=") run("zoomIn");
    else if (accelerator === "CmdOrCtrl+-") run("zoomOut");
    else if (accelerator === "CmdOrCtrl+0") run("zoomReset");
  });
  const nativeContext = useEffectEvent((id: string, picked: BrowserContextAction) => {
    if (id !== threadId) return;
    if (picked.action === "back") page.back();
    else if (picked.action === "forward") page.forward();
    else if (picked.action === "reload") page.reload();
    else if (picked.action === "openTab") openTab(picked.url);
    else if (picked.action === "annotate") requestAnnotate(threadId);
    else actions.viewSource();
  });
  useEffect(() => {
    const views = desktopBrowserViews();
    if (!views) return;
    const stopShortcut = views.onShortcut(nativeZoom);
    const stopContext = views.onContext(nativeContext);
    return () => {
      stopShortcut();
      stopContext();
    };
  }, []);

  const pointed = usePageTarget({ source, threadId, tabId: tab?.tabId, openTab });
  const menu: PageMenu = {
    target: pointed.target,
    locate: pointed.locate,
    openLink: pointed.openLink,
    copyLink: pointed.copyLink,
    copyImage: pointed.copyImage,
    saveImage: pointed.saveImage,
    canBack: page.canBack,
    canForward: page.canForward,
    back: page.back,
    forward: page.forward,
    reload: page.reload,
    copy: () => {
      if (!source.selection || !navigator.clipboard) return;
      void source
        .selection(threadId, tab?.tabId)
        .then((text) => (text ? navigator.clipboard.writeText(text) : undefined))
        .catch(() => toast.error({ title: "Couldn't copy the selection" }));
    },
    paste: () => {
      if (!navigator.clipboard) return;
      void navigator.clipboard
        .readText()
        .then(async (text) => {
          for (let index = 0; index < Math.min(text.length, 65536); index += 256) {
            const chunk: ForwardedInput = {
              kind: "key",
              event: "char",
              key: "Paste",
              text: text.slice(index, index + 256),
            };
            await source.input(threadId, chunk, tab?.tabId);
          }
        })
        .catch(() =>
          toast.error({
            title: "Couldn't paste",
            description: `Clipboard access is blocked in this browser. Use ${windowsPlatform ? "Ctrl+V" : "⌘V"} in the page.`,
          }),
        );
    },
    annotate: source.annotate ? () => requestAnnotate(threadId) : undefined,
    screenshot: () => actions.screenshot(false),
    viewSource: actions.viewSource,
    inspect: actions.devtoolsReason ?? (() => actions.devtools()),
  };

  const dialogs: ReactNode = (
    <>
      <HistoryDialog
        threadId={threadId}
        open={historyAt !== undefined}
        now={historyAt ?? 0}
        onOpenChange={(open) => setHistoryAt(open ? Date.now() : undefined)}
        onOpen={page.go}
        onOpenTab={openTab}
      />
      <ClearDataDialog
        open={clearing}
        engine={live?.backend}
        onOpenChange={setClearing}
        onClear={async () => {
          const done = await actions.clearData();
          if (done) history.clear(threadId);
          return done;
        }}
      />
      <PageSourceDialog source={actions.pageSource} onClose={actions.closeSource} />
    </>
  );

  return {
    tools,
    actions,
    menu,
    dialogs,
    downloads: { open: downloads, setOpen: setDownloads },
    openHistory: () => setHistoryAt(Date.now()),
    openClearData: () => setClearing(true),
    openSettings: () => void navigate({ to: "/settings/browser" }),
    /** A key pressed in the panel: true when it was a browser key (the event is then used). */
    key(event: Parameters<typeof pageKey>[0]): boolean {
      const key = pageKey(event);
      if (!key) return false;
      run(key);
      return true;
    },
  };
}

export type PageChrome = ReturnType<typeof usePageChrome>;
