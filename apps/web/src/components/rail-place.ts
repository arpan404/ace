/**
 * A place in the sidebar's rail: a bare 20px glyph in a 40px rounded box. The current place
 * takes the `--active` fill, hover the `--hover` wash; no tiles, no labels.
 */
export const railPlaceClass =
  "relative grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground aria-[current=page]:bg-active aria-[current=page]:text-foreground aria-expanded:bg-active aria-expanded:text-foreground";

/**
 * The small dot on a rail place's top-right corner, in its `data-tone`: `needs-you` (warning)
 * while something waits on the person, `unread` (blue) for news not yet seen.
 */
export const railDotClass =
  "absolute top-2 right-2 size-2 rounded-full bg-(--tone) ring-2 ring-sidebar";
