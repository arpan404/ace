import { useSyncExternalStore } from "react";

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
