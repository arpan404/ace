import type { WebContents } from "electron";

/**
 * A native tab's developer tools, in a window of their own (a view inside the app's window has
 * no dock). Already open, they come to the front. `at` (the page's coordinates) selects the
 * element there, as Inspect does in a browser.
 */
export function openDevTools(contents: WebContents, at?: { x: number; y: number }): void {
  if (contents.isDestroyed()) return;
  if (!contents.isDevToolsOpened()) contents.openDevTools({ mode: "detach", activate: true });
  else contents.devToolsWebContents?.focus();
  if (at) contents.inspectElement(Math.round(at.x), Math.round(at.y));
}

/** The system print dialog for a native tab. Resolves false if printing failed or was cancelled. */
export function printPage(contents: WebContents): Promise<boolean> {
  if (contents.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => contents.print({}, (success) => resolve(success)));
}
