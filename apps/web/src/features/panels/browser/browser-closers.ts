/*
 * What the thread's browser kind needs from the thread's mounted browser before the browser's
 * code is reachable from the kind: how to close one daemon tab when its panel tab closes, and
 * which daemon tab the daemon shows (so a reveal brings forward that tab, never another one).
 */
const closers = new Map<string, (tabId: string) => void>();
const shown = new Map<string, string>();

/** Register how to close a thread's daemon tabs; returns the unregister. */
export function registerBrowserCloser(scope: string, close: (tabId: string) => void): () => void {
  closers.set(scope, close);
  return () => {
    if (closers.get(scope) === close) closers.delete(scope);
  };
}

export function closeBrowserTab(scope: string, tabId: string): void {
  closers.get(scope)?.(tabId);
}

/** The daemon tab the person views in this thread's browser, as last reported. */
export function setShownBrowserTab(scope: string, tabId: string | undefined): void {
  if (tabId) shown.set(scope, tabId);
  else shown.delete(scope);
}

export function shownBrowserTab(scope: string): string | undefined {
  return shown.get(scope);
}
