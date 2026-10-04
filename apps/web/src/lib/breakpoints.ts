import { useMediaQuery } from "./media.ts";

/*
 * The window widths the shell adapts at, in one place. They line up with Tailwind's `sm`
 * (40rem) and `md` (48rem) so CSS-only tweaks and these hooks switch together.
 */

/** Below 640px: sheet panels, one header overflow, history left to the system. */
export const phoneQuery = "(max-width: 39.99rem)";
/** From 768px the sidebar sits beside the content; below it is a sheet. */
export const sidebarInlineQuery = "(min-width: 48rem)";
/** Below this width the panels float over the content instead of squeezing the column. */
export const overlayPanelsQuery = "(max-width: 72rem)";
/** Below 1100px an open right panel steps the sidebar down to icons until it closes. */
export const crowdedQuery = "(max-width: 68.75rem)";

export const usePhone = () => useMediaQuery(phoneQuery, false);
export const useSidebarInline = () => useMediaQuery(sidebarInlineQuery, true);
