export const DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE = "--desktop-titlebar-left-inset";
export const MAC_TITLEBAR_LEFT_INSET_PX = 90;
export const MAC_TITLEBAR_LEFT_INSET_STYLE = {
  paddingLeft: `var(${DESKTOP_TITLEBAR_LEFT_INSET_CSS_VARIABLE})`,
} as const;
export const DESKTOP_HEADER_CHROME_CLASS_NAME = "px-3.5 pt-3 pb-1";
export const DESKTOP_SIDEBAR_TOGGLE_CLASS_NAME =
  "size-8 shrink-0 rounded-lg border border-transparent bg-transparent text-foreground/45 shadow-none transition-all hover:!bg-accent hover:text-foreground active:!bg-accent/80";
