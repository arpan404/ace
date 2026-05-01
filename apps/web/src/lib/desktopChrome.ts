export const DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE = "--desktop-titlebar-left-inset";
export const MAC_TITLEBAR_LEFT_INSET_PX = 78;
export const MAC_TITLEBAR_LEFT_INSET_STYLE = {
  paddingLeft: `var(${DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE})`,
} as const;
export const DESKTOP_HEADER_CHROME_CLASS_NAME = "px-3.5 py-3";
export const DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME =
  "size-8 shrink-0 rounded-lg border border-transparent bg-transparent text-foreground/45 shadow-none transition-all hover:!bg-accent hover:text-foreground active:!bg-accent/80";
export const SIDEBAR_RESIZING_CLASS_NAME = "sidebar-resizing";
export const SIDEBAR_RESIZE_END_EVENT = "ace:sidebar-resize-end";
export const THREAD_BOARD_LAYOUT_ACTIVE_CLASS_NAME = "thread-board-layout-active";

export function isLayoutResizeInProgress(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const rootClasses = document.documentElement.classList;
  return (
    rootClasses.contains("native-window-resizing") ||
    rootClasses.contains(SIDEBAR_RESIZING_CLASS_NAME)
  );
}
