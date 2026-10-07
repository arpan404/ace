/*
 * The composer's geometry, in whole pixels on a 4px grid (SPEC "Composer"): one rounded surface
 * holding the message above a row of controls, and both keep their insets from one line to many.
 *
 *   input   14px above and 6px below 20px lines, 16px from the sides
 *   footer  a 44px row with 8px sides and 6px under it; every control is --composer-control
 *           (32px), so all control centres share one line
 *
 * The plus glyph (16px in a 32px box, 8px from the edge) starts where the text starts, 16px in.
 */
export const inputLine = 20;
/** Above and below the text, together. */
export const inputPadding = 20;

/** One size for every footer control; labels are 13/16 so nothing lands on a half pixel. */
const control =
  "inline-flex h-(--composer-control) items-center justify-center gap-1.5 rounded-full text-ui leading-4 font-medium text-muted-foreground outline-none transition-[background-color,color,transform] duration-(--dur-1) hover:bg-accent hover:text-foreground active:scale-[0.97] aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)] disabled:pointer-events-none disabled:opacity-40 data-disabled:pointer-events-none data-disabled:opacity-40";

/** A square icon control: plus, send and stop. It never gives up its room. */
export const iconControl = `${control} size-(--composer-control) shrink-0 px-0`;

/**
 * A labelled control (environment, approvals, model): it shrinks with the footer and its label
 * truncates, so a narrow composer never paints one control over another. It keeps at least its
 * icon's room.
 */
export const chipControl = `${control} min-w-(--composer-control) shrink px-2.5`;

/**
 * The surface a card attached to the composer sits on: tucked behind its top edge, narrower,
 * one step quieter than the composer itself.
 */
export const attachedSurface =
  "glass rounded-t-xl rounded-b-card bg-[color-mix(in_oklab,var(--glass-bg)_80%,var(--background))] shadow-[var(--glass-highlight),0_0_0_0.5px_var(--glass-edge),0_-12px_32px_-20px_rgb(0_0_0/0.5)]";
