import { useSyncExternalStore } from "react";

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

function ticker(periodMs: number): Ticker {
  const round = () => Math.floor(Date.now() / periodMs) * periodMs;
  let current = round();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    const next = round();
    if (next === current) return;
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

const minutes = ticker(60_000);
const seconds = ticker(1_000);
const none = () => () => {};
const wallClock = () => Math.floor(Date.now() / 1_000) * 1_000;

/** Wall-clock minutes for ages ("4m ago"). */
export function useNow(): number {
  return useSyncExternalStore(minutes.subscribe, minutes.read, minutes.read);
}

/**
 * Wall-clock time, re-rendering every second while `live`, for "Working for 12s" and
 * background task ages. Without `live` there is no timer; it reads the time when rendered.
 */
export function useSeconds(live: boolean): number {
  return useSyncExternalStore(
    live ? seconds.subscribe : none,
    live ? seconds.read : wallClock,
    live ? seconds.read : wallClock,
  );
}
