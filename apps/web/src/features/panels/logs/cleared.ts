import type { LocalStore } from "../store.ts";

/** Per thread: the log lines Clear hid, by key. */
export type ClearedLines = ReadonlyMap<string, ReadonlySet<string>>;

/** Threads whose Clear is remembered; the least recently cleared is forgotten first. */
const keptThreads = 64;

/** Hide the thread's lines `keys` (Clear). */
export function hideLogLines(
  store: LocalStore<ClearedLines>,
  threadId: string,
  keys: Iterable<string>,
): void {
  store.set((previous) => {
    const next = new Map(previous);
    next.delete(threadId);
    next.set(threadId, new Set(keys));
    for (const [oldest] of next) {
      if (next.size <= keptThreads) break;
      next.delete(oldest);
    }
    return next;
  });
}

/** Show the thread's cleared lines again. */
export function showLogLines(store: LocalStore<ClearedLines>, threadId: string): void {
  store.set((previous) => {
    if (!previous.has(threadId)) return previous;
    const next = new Map(previous);
    next.delete(threadId);
    return next;
  });
}
