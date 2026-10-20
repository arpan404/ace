import { tabKey, type ScopeWorkspace, type WorkspaceStore } from "@/lib/workspace/index.ts";
import { LocalStore } from "../store.ts";
import type { BrowserView } from "../sources.ts";

/** The panel as it was before watch mode, put back when it ends. */
type Layout = Pick<ScopeWorkspace, "open" | "active" | "size" | "expanded">;

/** Threads in watch mode, with the layout to return to. */
export const watching = new LocalStore<ReadonlyMap<string, Layout>>(new Map());

/** As wide as the panel goes beside the chat: the panel clamps it to leave the column room. */
const wide = 100_000;

/** The tab an agent works in now: the person's shown tab when it's one of them, else the first. */
export function agentTab(view: BrowserView | undefined): string | undefined {
  const tabs = view?.tabs ?? [];
  const used = tabs.filter((tab) => tab.inUse?.kind === "agent");
  return (used.find((tab) => tab.tabId === view?.activeTabId) ?? used[0])?.tabId;
}

/**
 * Watch mode: the agent's tab, large beside the chat (the panel as wide as it goes, that tab
 * showing), until the agent's run ends or the person leaves it.
 */
export function startWatching(store: WorkspaceStore, threadId: string, tabId: string): void {
  const current = store.get(threadId);
  if (!watching.get().has(threadId)) {
    const layout: Layout = {
      open: current.open,
      active: current.active,
      size: current.size,
      expanded: current.expanded,
    };
    watching.set((all) => new Map(all).set(threadId, layout));
  }
  follow(store, threadId, tabId);
}

/** Watch mode shows this tab now (the agent moved to another). */
export function follow(store: WorkspaceStore, threadId: string, tabId: string): void {
  const key = tabKey("browser", tabId);
  store.update(
    threadId,
    (workspace) =>
      workspace.tabs.some((tab) => tab.key === key)
        ? { ...workspace, open: true, expanded: false, active: key, size: wide }
        : workspace,
    { persist: false },
  );
}

/** Leave watch mode; `restore` puts the panel back as it was before. */
export function stopWatching(store: WorkspaceStore, threadId: string, restore: boolean): void {
  const layout = watching.get().get(threadId);
  if (!layout) return;
  watching.set((all) => {
    const next = new Map(all);
    next.delete(threadId);
    return next;
  });
  if (restore) store.update(threadId, (workspace) => ({ ...workspace, ...layout }));
}
