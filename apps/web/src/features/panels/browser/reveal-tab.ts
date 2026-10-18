import { useClient } from "@ace/client-react";
import { useWorkspaceActions, useWorkspaceStore } from "@/lib/workspace/index.ts";
import { panelServices } from "../services.ts";

/**
 * Show one of the thread's browser tabs to the person: the Browser comes forward in the side
 * panel (opening it) and the daemon makes `tabId` the tab they view. Resolves false when the
 * tab could not be shown (the browser closed, the tab is gone).
 */
export function useRevealBrowserTab(threadId: string): (tabId: string) => Promise<boolean> {
  const client = useClient();
  const actions = useWorkspaceActions(threadId);
  const store = useWorkspaceStore();
  return async (tabId) => {
    const panel = store.get(threadId).tabs.find((each) => each.kind === "browser");
    if (panel) {
      actions.activate(panel.key);
      actions.setOpen(true);
    } else actions.open({ kind: "browser" });
    try {
      await (await panelServices(client)).preview.selectTab(threadId, tabId);
      return true;
    } catch {
      return false;
    }
  };
}
