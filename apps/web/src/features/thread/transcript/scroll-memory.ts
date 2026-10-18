import type { VirtualItem } from "@tanstack/react-virtual";

/*
 * Where the reader was in each thread they left, for this session (in memory only), so going
 * back to a thread opens where they were reading instead of at its end. Pure: the store is a
 * value the I/O shell (`use-feed-scroll.ts`) owns.
 */

/** A thread's reading position as it was left. */
export interface SavedScroll {
  /** The first row in view, and how far its top sat from the viewport's top. */
  key: string;
  offset: number;
  /** The last row then: anything after it means new items arrived since. */
  lastKey: string | undefined;
  /** The rows' measured sizes by key, so the rows reopen at their real heights. */
  measured: readonly VirtualItem[];
}

export interface ScrollMemory {
  /** What was saved for a thread, if anything. */
  peek(threadId: string): SavedScroll | undefined;
  /** Remember a position, or forget it (the reader left at the live end). */
  save(threadId: string, saved: SavedScroll | undefined): void;
}

/** Remembers the `limit` threads left most recently. */
export function createScrollMemory(limit = 32): ScrollMemory {
  const threads = new Map<string, SavedScroll>();
  return {
    peek: (threadId) => threads.get(threadId),
    save(threadId, saved) {
      threads.delete(threadId);
      if (!saved) return;
      threads.set(threadId, saved);
      if (threads.size > limit) threads.delete(threads.keys().next().value ?? "");
    },
  };
}

/**
 * Where a thread reopens: the saved row, at its saved offset, when its rows still end where they
 * did and the row is still there. Undefined means the live end (new items arrived, or the row is
 * gone).
 */
export function restoreAt(
  saved: SavedScroll | undefined,
  keys: readonly string[],
): { index: number; offset: number } | undefined {
  if (!saved || keys.length === 0 || keys.at(-1) !== saved.lastKey) return undefined;
  const index = keys.lastIndexOf(saved.key);
  return index < 0 ? undefined : { index, offset: saved.offset };
}
