import type { ScrollMode } from "./scroll-mode.ts";

/*
 * How far the reader is from the transcript's live end, by the view's measured extent, and
 * what follows from it: whether Scroll to end shows, and whether a docked strip changing size
 * keeps the reader at the end. Pure; `use-feed-scroll.ts` measures and reports.
 */

/**
 * How close to the end still counts as at the end: 48px, about two lines of body text. More
 * than the few pixels a trackpad nudge, subpixel rounding or a strip's border leaves; less than
 * a deliberate scroll, so a reader who moved up to read is never treated as still at the end.
 */
export const nearEnd = 48;

/** What the scroller reports about its size and position. */
export interface Extent {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceToEnd(view: Extent): number {
  return Math.max(0, view.scrollHeight - view.scrollTop - view.clientHeight);
}

/** The view's bottom is within reach of the end. */
export const atEnd = (view: Extent): boolean => distanceToEnd(view) <= nearEnd;

/**
 * The transcript overflows by more than the near-end margin, so a reader could leave the end at
 * all. A gesture on a view that can't is not a reader scrolling away.
 */
export const canLeaveEnd = (view: Extent): boolean =>
  view.scrollHeight - view.clientHeight > nearEnd;

/**
 * Scroll to end shows only when the view stopped following and its bottom is more than the
 * near-end margin from the end. A transcript that doesn't overflow never shows it.
 */
export function showsScrollToEnd(mode: ScrollMode, view: Extent): boolean {
  return mode.kind !== "following" && distanceToEnd(view) > nearEnd;
}

/**
 * Docked content at the end (a question card, the approval strip, queued messages) grew or
 * shrank. A reader who nudged off following but was still within reach of the end (`before`:
 * their distance just before the change) keeps the end in view rather than having it pushed
 * away under them. A jump's row and a history window stay where they are.
 */
export function followsDockChange(mode: ScrollMode, before: number, detached: boolean): boolean {
  return !detached && mode.kind === "free" && before <= nearEnd;
}
