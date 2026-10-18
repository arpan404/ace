/** A browser key a tab's panel answers while it has focus, as a browser does. */
export type PageKey =
  | "address"
  | "find"
  | "reload"
  | "back"
  | "forward"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "print"
  | "history"
  | "devtools"
  | "source";

/**
 * The browser key a press means (⌘ on macOS, Ctrl elsewhere): ⌘L address, ⌘F find, ⌘R reload,
 * ⌘[ and ⌘] history, ⌘= or ⌘+ zoom in, ⌘- out, ⌘0 actual size, ⌘P print, ⌘Y history,
 * ⌥⌘I developer tools, ⌥⌘U page source. Undefined for every other key, which goes on to the
 * app or the page.
 */
export function pageKey(event: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): PageKey | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined;
  if (event.altKey) {
    if (event.shiftKey) return undefined;
    if (event.code === "KeyI") return "devtools";
    if (event.code === "KeyU") return "source";
    return undefined;
  }
  // ⌘+ is ⇧⌘= on most layouts.
  if (event.key === "+" || event.code === "Equal") return "zoomIn";
  if (event.shiftKey) return undefined;
  if (event.key === "-" || event.code === "Minus") return "zoomOut";
  if (event.key === "0" || event.code === "Digit0") return "zoomReset";
  if (event.code === "BracketLeft") return "back";
  if (event.code === "BracketRight") return "forward";
  const key = event.key.toLowerCase();
  if (key === "l") return "address";
  if (key === "f") return "find";
  if (key === "r") return "reload";
  if (key === "p") return "print";
  if (key === "y") return "history";
  return undefined;
}
