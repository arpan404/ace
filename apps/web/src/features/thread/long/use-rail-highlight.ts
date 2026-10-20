import { useEffect, useRef, useState, type RefObject } from "react";
import { restingHighlight, sampleScroll, settleAt, settleMs } from "./rail-highlight.ts";

/** The clock and timer the hook runs on; tests pass fakes. */
export interface RailHighlightTime {
  now(): number;
  after(ms: number, run: () => void): () => void;
}

/** The real clock and timers, used unless a test passes its own. */
export const browserTime: RailHighlightTime = {
  now: () => performance.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Whether the rail may mark the reader's turn: false while `scroller` is flung, true once it
 * settles. Scroll events update a ref; the component re-renders only when the answer flips.
 */
export function useRailHighlight(
  scroller: RefObject<HTMLElement | null> | undefined,
  time: RailHighlightTime = browserTime,
): boolean {
  const [shown, setShown] = useState(true);
  const state = useRef(restingHighlight);
  useEffect(() => {
    const element = scroller?.current;
    if (!element) return;
    let cancelSettle: (() => void) | undefined;
    const publish = () => setShown(state.current.shown);
    const settle = () => {
      cancelSettle = undefined;
      state.current = settleAt(state.current, time.now());
      publish();
    };
    const onScroll = () => {
      state.current = sampleScroll(state.current, element.scrollTop, time.now());
      publish();
      cancelSettle?.();
      // A fling that simply stops sends no more events: a timer notices the stillness.
      cancelSettle = state.current.shown ? undefined : time.after(settleMs, settle);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      cancelSettle?.();
    };
  }, [scroller, time]);
  return shown;
}
