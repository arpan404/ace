export const DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE = "--desktop-titlebar-left-inset";
export const MAC_TITLEBAR_LEFT_INSET_STYLE = {
  paddingLeft: `var(${DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE})`,
} as const;
export const DESKTOP_HEADER_CHROME_CLASS_NAME = "px-3.5 py-3";
export const DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME =
  "size-8 shrink-0 rounded-lg border border-transparent bg-transparent !text-foreground/45 shadow-none transition-all hover:!bg-accent hover:!text-foreground active:!bg-accent/80";
export const DESKTOP_HEADER_NAV_CLUSTER_CLASS_NAME =
  "group/sidebar-nav inline-flex h-8 shrink-0 items-center gap-1.5 text-foreground/48";
export const DESKTOP_HEADER_NAV_BUTTON_CLASS_NAME =
  "group/sidebar-nav-button inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent !p-0 !text-current shadow-none outline-none transition-[background-color,color,opacity,transform] duration-150 ease-out hover:!bg-foreground/[0.07] hover:!text-foreground/78 active:scale-[0.96] active:!bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-45 [&_svg]:drop-shadow-[0_1px_0_rgb(255_255_255/.06)]";
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
