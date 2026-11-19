import type { ThreadReader, ThreadSource } from "@ace/client";

/** Quiet time after the thread's last fact before images are asked for again. */
const settleMs = 750;
const readCursor = (reader: ThreadReader) => reader.cursor;

/**
 * Calls `refresh` once the thread's facts settle after a change: an image an answer shows may
 * have been captured since it was first asked for. Returns the unsubscribe.
 */
export function watchImageCaptures(store: ThreadSource, refresh: () => void): () => void {
  const cursor = store.select(["cursor"], readCursor);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = cursor.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, settleMs);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
