import { useConnectionState, useThreadMeta } from "@ace/client-react";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import type { BrowserTabView, BrowserView, PreviewSource } from "../sources.ts";
import { reason } from "./use-browser-features.ts";

/** The thread's browser as the daemon reports it, re-read on each change to the thread. */
function useLive(source: PreviewSource, threadId: string) {
  // The source's reads change with its version; read them again on each one.
  "use no memo";
  const subscribe = useCallback(
    (changed: () => void) => source.subscribe(changed, threadId),
    [source, threadId],
  );
  useSyncExternalStore(subscribe, () => source.version);
  // Follow the thread's browser and dev servers only while a view shows them.
  useEffect(() => source.watch(threadId), [source, threadId]);
  const view = source.view(threadId);
  return view && !view.closed ? view : undefined;
}

/** A fresh browser's only tab, still blank: an address goes there instead of a second tab. */
function blankOnly(view: BrowserView | undefined): string | undefined {
  const tabs = view?.tabs ?? [];
  const only = tabs[0];
  return tabs.length === 1 && only && (only.url === "about:blank" || only.url === "")
    ? only.tabId
    : undefined;
}

/**
 * The thread's tabs, shared by the person and agents on every device, as one panel tab sees
 * them: `ownId` is the daemon tab this panel tab shows (undefined for a new tab no daemon tab
 * backs yet). What the person does here: open a tab (shown at once), show this one, close one,
 * keep agents out of one. Nothing takes or hands back control.
 */
export function useBrowserTabs(source: PreviewSource, threadId: string, ownId: string | undefined) {
  const live = useLive(source, threadId);
  const toast = useToast();
  const workspaceId = useThreadMeta(threadId)?.workspaceId;
  const online = useConnectionState() === "ready";
  const tabs: readonly BrowserTabView[] = live?.tabs ?? [];
  const shownId = ownId;
  const shown = tabs.find((tab) => tab.tabId === shownId);

  const attempt = async <T>(title: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      toast.error({ title, description: reason(error) });
      return undefined;
    }
  };

  /**
   * A browser to put a page in: the thread's own, opened (downloading Chromium the first time)
   * when it has none. Throws when the thread's project isn't known yet.
   */
  const ensure = async (): Promise<BrowserView | undefined> => {
    if (live && live.status !== "paused") return live;
    if (!workspaceId) throw new Error("The thread's project isn't known yet.");
    return (await source.open(threadId, workspaceId)) ?? source.view(threadId);
  };

  /**
   * A new tab, shown at once, at `url` when given; resolves with its id. A browser opened just
   * for it puts the page in its first, blank tab rather than beside it.
   */
  const open = async (url?: string): Promise<string | undefined> => {
    const before = live;
    const view = await ensure();
    const blank = before ? undefined : blankOnly(view);
    if (blank) {
      if (url) await source.navigate(threadId, url, blank);
      return blank;
    }
    return source.openTab(threadId, url);
  };

  return {
    live,
    tabs,
    shownId,
    shown,
    online,
    reachable: live !== undefined || workspaceId !== undefined,
    /** Throws its failure, for callers that show it in place (the address bar). */
    open,
    /** Opens the thread's browser (bringing back its tabs after a daemon restart). */
    ensure: () => attempt("Couldn't open the browser", ensure),
    /** A browser that lost its pages opens them again at their last addresses. */
    reopen: () =>
      void attempt("Couldn't reopen the browser", async () => {
        if (!workspaceId) throw new Error("The thread's project isn't known yet.");
        await source.open(threadId, workspaceId);
      }),
    /** Show this tab to the person, on every device (the daemon's shown tab). */
    select: (tabId: string) => {
      if (tabId === live?.activeTabId) return;
      void attempt("Couldn't show the tab", () => source.selectTab(threadId, tabId));
    },
    close: (tabId: string) =>
      void attempt("Couldn't close the tab", () => source.closeTab(threadId, tabId)),
    keepPrivate: (tabId: string, value: boolean) =>
      void attempt(
        value ? "Couldn't keep agents out of the tab" : "Couldn't let agents into the tab",
        () => source.keepPrivate(threadId, tabId, value),
      ),
  };
}

export type BrowserTabs = ReturnType<typeof useBrowserTabs>;
