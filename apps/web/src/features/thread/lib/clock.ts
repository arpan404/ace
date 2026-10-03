import { useCallback, useSyncExternalStore } from "react";

/** "4m 12s", "38s", "1h 2m". Pure. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "14:02" in the reader's locale. */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

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
