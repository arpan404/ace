/**
 * Whether the rail marks the reader's turn while the transcript scrolls. A fling sweeps the
 * current turn through many ticks a second, and a mark chasing it flickers; so the mark hides
 * while the scroll is fast and returns once it has been slow, or still, for a moment.
 * Pure: the caller feeds scroll positions with their times, and asks again when a timer fires.
 */

/** Faster than this, in pixels per millisecond, the scroll is a fling and the mark hides. */
export const flingSpeed = 1.75;
/** How long, in milliseconds, the scroll must stay slow (or still) before the mark returns. */
export const settleMs = 140;

export interface RailHighlight {
  readonly shown: boolean;
  /** The last scroll sample: where the transcript was, and when. */
  readonly position?: number;
  readonly time?: number;
  /** When the scroll dropped below fling speed while the mark was hidden. */
  readonly calmSince?: number;
}

export const restingHighlight: RailHighlight = { shown: true };

/** The transcript reached `position` at `time`. */
export function sampleScroll(state: RailHighlight, position: number, time: number): RailHighlight {
  if (state.position === undefined || state.time === undefined) return { ...state, position, time };
  const elapsed = time - state.time;
  // Two samples in one instant say nothing about speed: the next one measures across both.
  if (elapsed <= 0) return state;
  const speed = Math.abs(position - state.position) / elapsed;
  if (speed > flingSpeed) return { shown: false, position, time };
  if (state.shown) return { shown: true, position, time };
  // The whole interval since the previous sample was slow, so the calm began there.
  const calmSince = state.calmSince ?? state.time;
  return { shown: time - calmSince >= settleMs, position, time, calmSince };
}

/** No sample arrived up to `now`: a scroll that stayed calm or still for the window has settled. */
export function settleAt(state: RailHighlight, now: number): RailHighlight {
  if (state.shown || state.time === undefined) return state;
  return now - (state.calmSince ?? state.time) >= settleMs ? { ...state, shown: true } : state;
}
