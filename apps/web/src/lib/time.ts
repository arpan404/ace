import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Shared wall clocks for ages and durations in the UI. One timer per period for the whole page,
 * running only while something reads it and the page is visible: a hidden tab does no work for
 * its clocks, and they catch up the moment it is shown.
 */
interface Ticker {
  subscribe(changed: () => void): () => void;
  read(): number;
}

const hidden = () => typeof document === "object" && document.visibilityState === "hidden";

/**
 * `exact` clocks read the wall time at each tick; the others read it rounded down to the period,
 * so a snapshot stays the same until the period turns.
 */
function ticker(now: () => number, periodMs: number, exact: boolean): Ticker {
  const round = () => (exact ? now() : Math.floor(now() / periodMs) * periodMs);
  let current = round();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    const next = round();
    // An exact clock moves only once it is half a period stale, so a new reader rarely
    // re-renders the others, and a timer firing a little early still moves it.
    if (next === current || (exact && next - current < periodMs / 2)) return;
    current = next;
    for (const listener of listeners) listener();
  };
  const start = () => {
    if (timer === undefined && listeners.size && !hidden()) timer = setInterval(tick, periodMs);
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const visibility = () => {
    if (hidden()) return stop();
    tick();
    start();
  };
  return {
    subscribe(changed) {
      if (!listeners.size && typeof document === "object")
        document.addEventListener("visibilitychange", visibility);
      listeners.add(changed);
      tick();
      start();
      return () => {
        listeners.delete(changed);
        if (listeners.size) return;
        stop();
        if (typeof document === "object")
          document.removeEventListener("visibilitychange", visibility);
      };
    },
    read: () => current,
  };
}

/** Injectable wall-clock boundary; the default belongs to the browser's I/O shell. */
export function createTimeSource(now: () => number) {
  return {
    minutes: ticker(now, 60_000, true),
    seconds: ticker(now, 1_000, false),
    read: () => Math.floor(now() / 1_000) * 1_000,
  };
}
export const TimeContext = createContext(createTimeSource(() => Date.now()));
const none = () => () => {};

/** Wall-clock minutes for ages ("4m ago"). */
export function useNow(): number {
  const { minutes } = useContext(TimeContext);
  return useSyncExternalStore(minutes.subscribe, minutes.read, minutes.read);
}

/**
 * Wall-clock time, re-rendering every second while `live`, for "Working for 12s" and
 * background task ages. Without `live` there is no timer; it reads the time when rendered.
 */
export function useSeconds(live: boolean): number {
  const { seconds, read } = useContext(TimeContext);
  return useSyncExternalStore(
    live ? seconds.subscribe : none,
    live ? seconds.read : read,
    live ? seconds.read : read,
  );
}
