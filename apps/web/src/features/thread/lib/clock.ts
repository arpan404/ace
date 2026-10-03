import { useCallback, useSyncExternalStore } from "react";

/**
 * Wall-clock time, re-rendering every second while `live`, for "Working for 12s" and
 * background task ages. Without `live` there is no timer; it reads the time when rendered.
 */
export function useTicker(live: boolean): number {
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!live) return () => {};
      const timer = setInterval(changed, 1000);
      return () => clearInterval(timer);
    },
    [live],
  );
  return useSyncExternalStore(subscribe, wholeSecond, wholeSecond);
}

// Stable within a second, so React sees the same snapshot until the tick.
const wholeSecond = () => Math.floor(Date.now() / 1000) * 1000;
