import { useSyncExternalStore } from "react";

/*
 * An opener's ask that the thread's Deck show its explorer (a mention whose name several files
 * share, filtered to that name). A wide Deck shows it from the layout; a compact one keeps its
 * overlay outside the layout, so it hears the ask here. Left until the Deck takes it, so a Deck
 * that mounts or measures after the ask still sees it. One per thread; a newer ask replaces it.
 */

const pending = new Map<string, number>();
const listeners = new Set<() => void>();
let tokens = 0;

const emit = () => {
  for (const listener of listeners) listener();
};

/** Ask the thread's Deck to show its explorer. */
export function requestExplorer(thread: string): void {
  pending.set(thread, ++tokens);
  emit();
}

/** The Deck took the ask: forget it, unless a newer one has replaced it. */
export function settleExplorerAsk(thread: string, token: number): void {
  if (pending.get(thread) !== token) return;
  pending.delete(thread);
  emit();
}

/** The waiting ask's token, if any; each ask has its own, so a repeat still shows. */
export function useExplorerAsk(thread: string): number | undefined {
  return useSyncExternalStore(subscribe, () => pending.get(thread));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
