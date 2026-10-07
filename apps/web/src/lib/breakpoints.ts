import { useMediaQuery } from "./media.ts";

/*
 * The window widths the shell adapts at, in one place. They line up with Tailwind's `sm`
 * (40rem) and `md` (48rem) so CSS-only tweaks and these hooks switch together.
 */

/** Below 640px: sheet panels, one header overflow, history left to the system. */
export const phoneQuery = "(max-width: 39.99rem)";
/**
 * From 768px the sidebar sits beside the content; below it is a sheet. A short touch screen (a
 * phone held sideways) gets the sheet too, so the transcript keeps its height.
 */
export const sidebarInlineQuery =
  "(min-width: 48rem) and (not ((pointer: coarse) and (max-height: 32rem)))";
/** At 896px and below the panels float over the content instead of squeezing the column. */
export const overlayPanelsQuery = "(max-width: 56rem)";
/**
 * Below 1100px an open right panel steps the sidebar aside until it closes, which is what lets
 * the side panel beside the column there (above `overlayPanelsQuery`).
 */
export const crowdedQuery = "(max-width: 68.75rem)";

export const usePhone = () => useMediaQuery(phoneQuery, false);
export const useSidebarInline = () => useMediaQuery(sidebarInlineQuery, true);
