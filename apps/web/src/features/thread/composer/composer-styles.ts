/*
 * The composer's geometry, in whole pixels on a 4px grid (SPEC "Composer"): the shell is an input
 * area above a footer, and both keep their insets from one line to many.
 *
 *   input   12px top and bottom around 20px lines, 16px from the sides
 *   footer  a 40px row with 8px sides and 4px under it; every control is --composer-control
 *           (32px), so all control centres share one line, 4px + 1px border from the bottom
 *           and 8px + 1px from the sides
 *
 * The plus glyph (16px in a 32px box, 8px from the edge) starts where the text starts, 16px in.
 */
export const inputLine = 20;
export const inputPadding = 12;

/** One size for every footer control; labels are 13/16 so nothing lands on a half pixel. */
export const control =
  "inline-flex h-(--composer-control) min-w-(--composer-control) shrink-0 items-center justify-center gap-1.5 rounded-full text-[13px] leading-4 font-medium text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] disabled:pointer-events-none disabled:opacity-40 data-disabled:pointer-events-none data-disabled:opacity-40";

/** A square icon control: plus, the meter, send and stop. */
export const iconControl = `${control} w-(--composer-control) px-0`;

/** A labelled control (permission, model): its label truncates before it squeezes anything. */
export const chipControl = `${control} min-w-0 px-2.5`;
