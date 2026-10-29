import { useConnectionState, useThreadMeta } from "@ace/client-react";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import { activateTab, shownTab, tabKey, useWorkspaceStore } from "@/lib/workspace/index.ts";
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

/** Threads whose browser is moving engines: opens wait for the move, not a blank page. */
const engineSwitches = new Map<string, Promise<void>>();

/**
 * Finished engine switches, by thread: the reloaded daemon tab the panel shows again, so the
 * person lands back on the tab they switched instead of the fallback the close left behind.
 * One shot; `ThreadBrowser` consumes and drops it.
 */
export const switchFollows = new Map<string, string>();

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
  const store = useWorkspaceStore();
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
   * when it has none. While its engine moves, the move's own browser wins: opening beside it
   * would start a blank one the move then replaces. Throws when the thread's project isn't
   * known yet.
   */
  const ensure = async (): Promise<BrowserView | undefined> => {
    const moving = engineSwitches.get(threadId);
    if (moving) {
      await moving.catch(() => {});
      const current = source.view(threadId);
      if (current && current.status !== "paused") return current;
    } else if (live && live.status !== "paused") return live;
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
        const moving = engineSwitches.get(threadId);
        if (moving) await moving.catch(() => {});
        if (!workspaceId) throw new Error("The thread's project isn't known yet.");
        await source.open(threadId, workspaceId);
      }),
    /** Show this tab to the person, on every device (the daemon's shown tab). */
    select: (tabId: string) => {
      if (tabId === live?.activeTabId) return;
      // An engine switch owns the daemon's shown tab while it moves, and until the panel
      // lands on the reloaded tab: a panel tab mounting meanwhile must not select its own
      // tab back over the move.
      if (engineSwitches.has(threadId)) return;
      const follow = switchFollows.get(threadId);
      if (follow !== undefined && tabId !== follow) return;
      void attempt("Couldn't show the tab", () => source.selectTab(threadId, tabId));
    },
    close: (tabId: string) =>
      void attempt("Couldn't close the tab", () => source.closeTab(threadId, tabId)),
    keepPrivate: (tabId: string, value: boolean) =>
      void attempt(
        value ? "Couldn't keep agents out of the tab" : "Couldn't let agents into the tab",
        () => source.keepPrivate(threadId, tabId, value),
      ),
    /**
     * Run this thread's browser on another engine: its tabs load again at their addresses on
     * the new one. Only in the desktop app, where the in-app browser lives. Opens hold while
     * the move runs, so none starts a blank browser beside it.
     */
    switchEngine: (engine: "embedded" | "headless") =>
      void attempt("Couldn't switch the browser engine", async () => {
        if (!workspaceId) throw new Error("The thread's project isn't known yet.");
        if (!source.switchEngine) throw new Error("Switching engines needs a newer app.");
        let release!: () => void;
        const done = new Promise<void>((resolve) => {
          release = resolve;
        });
        engineSwitches.set(threadId, done);
        try {
          const moved = await source.switchEngine(threadId, engine, workspaceId);
          // Show the reloaded tab again, instead of the fallback the close left behind.
          // The panel tab usually exists already (the state push lands before this
          // resolves); otherwise ThreadBrowser picks it up from `switchFollows`.
          const follow = moved.activeTabId;
          if (follow) {
            const current = store.get(threadId);
            const key = tabKey("browser", follow);
            const placed = current.open && current.tabs.some((tab) => tab.key === key);
            if (placed && shownTab(current)?.id !== follow) {
              store.update(threadId, (workspace) => activateTab(workspace, key));
            } else if (!placed) {
              switchFollows.set(threadId, follow);
            }
          }
        } finally {
          if (engineSwitches.get(threadId) === done) engineSwitches.delete(threadId);
          release();
        }
      }),
  };
}

export type BrowserTabs = ReturnType<typeof useBrowserTabs>;
