/**
 * The reading column's box. The transcript's text and the composer's shell both sit inside it,
 * padding included, so their left and right edges agree at every width. While the Work card is
 * docked (`data-work-docked` on the thread area) the sides slim to 16px and the column settles
 * left by half the card's reserve, centring in what is left of the full-width scroller; the
 * scroller keeps its width, so its scrollbar stays at the area's far right edge. The
 * composer's dock counter-shifts its own box (it already insets by the reserve), so this one
 * shift keeps every column on the same axis. Both overrides fall away with the attribute when
 * the card closes.
 */
export const readingColumn =
  "mx-auto w-full max-w-(--column) px-5 sm:px-8 [[data-work-docked]_&]:px-4 [[data-work-docked]_&]:-translate-x-[calc(var(--work-reserve,0px)/2)]";
