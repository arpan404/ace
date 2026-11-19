import { useSyncExternalStore } from "react";
import { useMediaQuery } from "./media.ts";

/*
 * The window widths the shell adapts at, in one place. Only the shell's own frame (sidebar,
 * panels, sheets) follows the window; anything inside a column follows that column's width
 * (container queries or a measured width), never these.
 */

/**
 * Below 640px: the side panel takes the column's place, one header overflow, history left to
 * the system. Kept in step with `roomLimits.phone` (`shell-room.ts`).
 */
export const phoneQuery = "(max-width: 39.99rem)";
/**
 * Above 896px the sidebar sits beside the content; at and below it (a tablet's 768, say) it is
 * a sheet, so the thread column keeps its full width. A short touch screen (a phone held
 * sideways) gets the sheet too, so the transcript keeps its height.
 */
export const sidebarInlineQuery =
  "(min-width: 56.0625rem) and (not ((pointer: coarse) and (max-height: 32rem)))";
/** A phone-sized window, or any touch-first screen: where the composer may fold into a pill. */
export const handheldQuery = `${phoneQuery}, (pointer: coarse) and (max-width: 47.99rem)`;

export const usePhone = () => useMediaQuery(phoneQuery, false);
export const useHandheld = () => useMediaQuery(handheldQuery, false);
export const useSidebarInline = () => useMediaQuery(sidebarInlineQuery, true);

const wideWindow = 1440;
const subscribeResize = (changed: () => void) => {
  globalThis.addEventListener?.("resize", changed);
  return () => globalThis.removeEventListener?.("resize", changed);
};
/**
 * The window's width, for sharing it between the sidebar, the column and the side panel
 * (`shell-room.ts`). Where there is no matchMedia (tests that set no window size) it answers as
 * a wide desktop window, as the media hooks above do.
 */
const readWindowWidth = () =>
  typeof globalThis.matchMedia === "function" ? globalThis.innerWidth : wideWindow;
export const useWindowWidth = () =>
  useSyncExternalStore(subscribeResize, readWindowWidth, () => wideWindow);
