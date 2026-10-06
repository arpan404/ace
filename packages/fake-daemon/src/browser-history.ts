import { canStep, emptyHistory, stepHistory, visitPage, type PageHistory } from "@ace/ui-core";

/** Synthetic document history follows tabs, independently of the UI's attempted addresses. */
export class BrowserDocumentHistory {
  private tabs = new Map<string, PageHistory>();
  visit(tabId: string, url: string) {
    this.tabs.set(tabId, visitPage(this.tabs.get(tabId) ?? emptyHistory, url));
  }
  remove(tabId: string) {
    this.tabs.delete(tabId);
  }
  capabilities(tabId: string) {
    const history = this.tabs.get(tabId) ?? emptyHistory;
    return { back: canStep(history, -1), forward: canStep(history, 1) };
  }
  move(tabId: string, direction: "back" | "forward" | "reload") {
    const history = this.tabs.get(tabId) ?? emptyHistory;
    const next =
      direction === "reload" ? history : stepHistory(history, direction === "back" ? -1 : 1);
    if (direction !== "reload" && next === history) return undefined;
    this.tabs.set(tabId, next);
    return next.entries[next.index];
  }
}
