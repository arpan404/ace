import { useSyncExternalStore } from "react";

/*
 * Titles of threads this window just started (UX audit TN-1), by thread id, while the daemon's
 * own title still says "New thread". `StartedRows` publishes them once it has loaded; a row
 * reads its own, so nobody sees "New thread" after sending.
 */
let titles: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();

export function publishStartedTitles(next: ReadonlyMap<string, string>): void {
  titles = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => titles;

/** The provisional title this window gave the thread, if it started it. */
export function useStartedTitle(threadId: string): string | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot).get(threadId);
}
