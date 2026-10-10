/*
 * The composer's geometry, in whole pixels on a 4px grid (SPEC "Composer"): one rounded surface
 * holding the message above a row of controls, and both keep their insets from one line to many.
 *
 *   input   a fixed frame with 14px above and 6px below 20px lines, 16px from the sides
 *   footer  a 44px row with 8px sides and 6px under it; every control is --composer-control
 *           (32px), so all control centres share one line
 *
 * The plus glyph (16px in a 32px box, 8px from the edge) starts where the text starts, 16px in.
 */
export const inputLine = 20;

/** One size for every footer control; labels are 13/16 so nothing lands on a half pixel. */
const control =
  "inline-flex h-(--composer-control) items-center justify-center gap-1.5 rounded-sm text-ui leading-4 font-medium text-muted-foreground outline-none transition-[background-color,color,transform] duration-(--dur-1) hover:bg-accent hover:text-foreground active:scale-95 aria-expanded:text-foreground focus-visible:bg-accent focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-40 data-disabled:pointer-events-none data-disabled:opacity-40";

/** A square icon control: plus, send and stop. It never gives up its room. */
export const iconControl = `${control} size-(--composer-control) shrink-0 px-0`;

/** A labelled filled action in the send slot: Submit ↑ and Next →. */
export const pillControl = `${control} shrink-0 gap-1 pr-2.5 pl-3.5`;

/**
 * A labelled control (the model): it shrinks with the footer and its label
 * truncates, so a narrow composer never paints one control over another. It keeps at least its
 * icon's room.
 */
export const chipControl = `${control} min-w-(--composer-control) shrink px-2.5`;

/** One material for the input and its attached panels. Cast shadows would tint the footer. */
export const composerSurface = "glass border border-sidebar-border shadow-none outline-none";

/** The same glass, tucked behind the input's edge on a narrower panel. */
export const attachedSurface = `${composerSurface} rounded-xl`;

/** The matching lower flap: its top edge sits behind the input surface. */
export const environmentSurface = `${attachedSurface} relative z-0 mx-4 -mt-4 pt-4`;

/** A one-line tab's row: 36px, the composer's text size, a step quieter than the message. */
const stripRowLayout = "flex min-w-0 items-center gap-1 px-2 text-ui text-muted-foreground";
export const stripRow = `${stripRowLayout} h-9`;
/** Environment stays shorter than the attached status and plan rows. */
export const environmentRow = `${stripRowLayout} h-7`;

/** A control on a tab's row: a 28px pill, quiet until hovered or open. */
export const stripControl =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-2 outline-none transition-colors duration-(--dur-1) hover:bg-accent hover:text-foreground aria-expanded:text-foreground focus-visible:bg-accent focus-visible:text-foreground";
