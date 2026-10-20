import { useClient } from "@ace/client-react";
import { useCallback } from "react";
import { tabKey, useWorkspaceActions, useWorkspaceStore } from "@/lib/workspace/index.ts";
import { panelServices } from "../services.ts";
import { shownBrowserTab } from "./browser-closers.ts";

/**
 * Bring the thread's Browser forward in the side panel, opening the panel: the panel tab of
 * `tabId` (else of the tab the daemon shows the person), else any Browser tab, else a new one.
 */
export function useShowBrowserPanel(threadId: string): (tabId?: string) => void {
  const actions = useWorkspaceActions(threadId);
  const store = useWorkspaceStore();
  return useCallback(
    (tabId?: string) => {
      const tabs = store.get(threadId).tabs;
      const wanted = tabId ?? shownBrowserTab(threadId);
      const panel =
        tabs.find((each) => wanted !== undefined && each.key === tabKey("browser", wanted)) ??
        tabs.find((each) => each.kind === "browser");
      if (panel) {
        actions.activate(panel.key);
        actions.setOpen(true);
      } else actions.open({ kind: "browser" });
    },
    [threadId, store, actions],
  );
}

/**
 * Show one of the thread's browser tabs to the person: the Browser comes forward in the side
 * panel (opening it) and the daemon makes `tabId` the tab they view. Resolves false when the
 * tab could not be shown (the browser closed, the tab is gone).
 */
export function useRevealBrowserTab(threadId: string): (tabId: string) => Promise<boolean> {
  const client = useClient();
  const show = useShowBrowserPanel(threadId);
  return async (tabId) => {
    show(tabId);
    try {
      await (await panelServices(client)).preview.selectTab(threadId, tabId);
      return true;
    } catch {
      return false;
    }
  };
}
