import type { BrowserPageView } from "../sources.ts";

/**
 * Each watched thread's tabs' latest page state (`browser.page`). The daemon sends a tab's whole
 * state on every change and again to each new subscription, so the store only keeps the latest
 * and forgets what can no longer be true: a closed tab, a replaced backend, a lost connection.
 * Mutations return whether anything a view reads changed.
 */
export class PageStates {
  private threads = new Map<string, Map<string, BrowserPageView>>();
  get(threadId: string, tabId: string): BrowserPageView | undefined {
    return this.threads.get(threadId)?.get(tabId);
  }
  set(threadId: string, tabId: string, page: BrowserPageView): boolean {
    let tabs = this.threads.get(threadId);
    if (!Object.keys(page).length) {
      if (!tabs?.delete(tabId)) return false;
      if (!tabs.size) this.threads.delete(threadId);
      return true;
    }
    if (!tabs) {
      tabs = new Map();
      this.threads.set(threadId, tabs);
    }
    tabs.set(tabId, page);
    return true;
  }
  /** Drops tabs the thread no longer has. */
  keep(threadId: string, tabIds: readonly string[]): boolean {
    const tabs = this.threads.get(threadId);
    if (!tabs) return false;
    let changed = false;
    for (const tabId of tabs.keys())
      if (!tabIds.includes(tabId)) changed = tabs.delete(tabId) || changed;
    if (!tabs.size) this.threads.delete(threadId);
    return changed;
  }
  delete(threadId: string): boolean {
    return this.threads.delete(threadId);
  }
  clear(): void {
    this.threads.clear();
  }
}
