/*
 * Closing the Browser panel tab closes the person's own tabs in the thread's browser (agents
 * keep theirs). The panel tab's kind closes before the browser's code is reachable from it, so
 * the thread's mounted browser registers how to do it here.
 */
const closers = new Map<string, () => void>();

/** Register how to close a thread's tabs; returns the unregister. */
export function registerBrowserCloser(scope: string, close: () => void): () => void {
  closers.set(scope, close);
  return () => {
    if (closers.get(scope) === close) closers.delete(scope);
  };
}

export function closeBrowserTabs(scope: string): void {
  closers.get(scope)?.();
}
