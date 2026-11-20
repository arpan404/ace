import { useSyncExternalStore } from "react";

/*
 * Where an open asked the editor to look (spec 12–13): the line and column to reveal, a match to
 * select, and whether the keyboard follows into the editor. The opener leaves it here; the
 * group's editor takes it once it shows that file, then clears it. One per thread: a newer open
 * replaces an older one nobody has taken yet.
 */

export interface Reveal {
  path: string;
  group: string;
  /** 1-based. */
  line?: number | undefined;
  /** 0-based UTF-16 column on `line`. */
  column?: number | undefined;
  /** With `column`, select this many code units there (a search match). */
  length?: number | undefined;
  /** Move the keyboard into the editor (a deliberate or keyboard open), else leave focus be. */
  focus: boolean;
  /** Tells two reveals of the same place apart, so the second still reveals. */
  token: number;
}

const pending = new Map<string, Reveal>();
const listeners = new Set<() => void>();
let tokens = 0;

const emit = () => {
  for (const listener of listeners) listener();
};

/** Ask the thread's editor to reveal a place in a file the open just showed. */
export function requestReveal(thread: string, reveal: Omit<Reveal, "token">): void {
  pending.set(thread, { ...reveal, token: ++tokens });
  emit();
}

/** The editor took the reveal: forget it, unless a newer one has replaced it. */
export function settleReveal(thread: string, token: number): void {
  if (pending.get(thread)?.token !== token) return;
  pending.delete(thread);
  emit();
}

/** The reveal waiting for `path` in `group`, if any. */
export function useReveal(thread: string, group: string, path: string): Reveal | undefined {
  return useSyncExternalStore(subscribe, () => {
    const reveal = pending.get(thread);
    return reveal && reveal.group === group && reveal.path === path ? reveal : undefined;
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
