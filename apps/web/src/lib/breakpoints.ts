import { useMediaQuery } from "./media.ts";

/*
 * The window widths the shell adapts at, in one place. Only the shell's own frame (sidebar,
 * panels, sheets) follows the window; anything inside a column follows that column's width
 * (container queries or a measured width), never these.
 */

/** Below 640px: sheet panels, one header overflow, history left to the system. */
export const phoneQuery = "(max-width: 39.99rem)";
/**
 * Above 896px the sidebar sits beside the content; at and below it (a tablet's 768, say) it is
 * a sheet, so the thread column keeps its full width. A short touch screen (a phone held
 * sideways) gets the sheet too, so the transcript keeps its height.
 */
export const sidebarInlineQuery =
  "(min-width: 56.0625rem) and (not ((pointer: coarse) and (max-height: 32rem)))";
/** At 896px and below the panels float over the content instead of squeezing the column. */
export const overlayPanelsQuery = "(max-width: 56rem)";
/**
 * Below 1100px an open right panel steps the sidebar aside until it closes, which is what lets
 * the side panel beside the column there (above `overlayPanelsQuery`).
 */
export const crowdedQuery = "(max-width: 68.75rem)";

/** A phone-sized window, or any touch-first screen: where the composer may fold into a pill. */
export const handheldQuery = `${phoneQuery}, (pointer: coarse) and (max-width: 47.99rem)`;

export const usePhone = () => useMediaQuery(phoneQuery, false);
export const useHandheld = () => useMediaQuery(handheldQuery, false);
export const useSidebarInline = () => useMediaQuery(sidebarInlineQuery, true);
