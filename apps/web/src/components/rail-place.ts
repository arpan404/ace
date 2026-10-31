/**
 * A place in the sidebar's rail: a bare 19px glyph in a 36px rounded box. The current place
 * takes the `--active` fill, hover the `--hover` wash; no tiles, no labels.
 */
export const railPlaceClass =
  "relative grid size-9 shrink-0 place-items-center rounded-[10px] text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground aria-[current=page]:bg-active aria-[current=page]:text-foreground aria-expanded:bg-active aria-expanded:text-foreground";

/** The needs-you dot on a rail place's top-right corner, in the warning colour. */
export const railDotClass =
  "absolute top-1.5 right-1.5 size-2 rounded-full bg-(--tone) ring-2 ring-sidebar";
