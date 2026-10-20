/*
 * How far ahead of the reader history starts loading, so a page lands before they reach the end
 * of what is loaded and the transcript reads as one endless list. Pure: the I/O shell
 * (`use-history-paging.ts`) feeds it scroll positions and times.
 */

/** Screens of rows always kept loaded ahead of the reader. */
export const screensAhead = 3;
/** The least distance ahead, for short viewports. */
export const minAhead = 2_400;
/** How long a page may take to arrive and lay out: the distance the reader covers in it. */
export const leadMs = 1_000;
/** Scroll events further apart than this are a pause: the reader's speed starts over. */
const pauseMs = 150;

/** Where the reader is and how fast they move (px/ms; positive toward older history). */
export interface ScrollSpeed {
  top: number;
  at: number;
  speed: number;
}

/**
 * How close (px) to the end of what is loaded the reader may come before the next page is read:
 * a few screens, or further when they move fast enough to cover that before a page lands.
 */
export function prefetchDistance(viewport: number, speed: number): number {
  return Math.max(minAhead, screensAhead * viewport, Math.abs(speed) * leadMs);
}

/**
 * The reader's speed after a scroll to `top` at `at`, smoothed over recent scrolls. A move of
 * more than a couple of screens in one scroll is the view being placed (a page landing above, a
 * jump), not the reader, and leaves the speed as it was.
 */
export function nextSpeed(
  previous: ScrollSpeed | undefined,
  top: number,
  at: number,
  viewport: number,
): ScrollSpeed {
  if (!previous || at - previous.at > pauseMs) return { top, at, speed: 0 };
  const moved = previous.top - top;
  if (Math.abs(moved) > 2 * Math.max(viewport, 1)) return { ...previous, top, at };
  const sample = moved / Math.max(at - previous.at, 1);
  return { top, at, speed: previous.speed * 0.4 + sample * 0.6 };
}

/** The reader's speed toward `older` (or newer) history now: none once they have paused. */
export function speedToward(older: boolean, speed: ScrollSpeed | undefined, now: number): number {
  if (!speed || now - speed.at > pauseMs) return 0;
  return Math.max(0, older ? speed.speed : -speed.speed);
}
