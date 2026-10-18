import { useEffect, useEffectEvent } from "react";

const listeners = new Map<string, Set<() => void>>();

/**
 * "Annotate this element" from a page's right-click menu: the thread's Annotate button starts
 * annotate mode, as if it were pressed (it owns the mode and its session).
 */
export function requestAnnotate(threadId: string): void {
  for (const listener of listeners.get(threadId) ?? []) listener();
}

/** The Annotate button's side of `requestAnnotate`. */
export function useAnnotateRequests(threadId: string, start: () => void): void {
  const run = useEffectEvent(start);
  useEffect(() => {
    let set = listeners.get(threadId);
    if (!set) {
      set = new Set();
      listeners.set(threadId, set);
    }
    const listener = () => run();
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size) listeners.delete(threadId);
    };
  }, [threadId]);
}
