import { useSyncExternalStore } from "react";

/** "now", "2m", "3h", "4d", "6w": the compact ages in lists. Pure; the caller supplies now. */
export function formatAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

const minute = 60_000;
let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Wall-clock minutes for ages in the UI. One shared timer, running only while subscribed. */
export function useNow(): number {
  return useSyncExternalStore(
    (changed) => {
      listeners.add(changed);
      timer ??= setInterval(() => {
        current = Date.now();
        for (const listener of listeners) listener();
      }, minute);
      return () => {
        listeners.delete(changed);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    () => current,
    () => current,
  );
}
