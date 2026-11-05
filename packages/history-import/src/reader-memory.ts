import { isMainThread } from "node:worker_threads";

/** How the reader keeps memory it no longer uses from counting against its limit. */
export interface ReaderMemory {
  /** A full collection now, before a read that must start from a clean heap. */
  collect(): void;
  /** Between batches: a full collection once the reader is past three quarters of its limit. */
  relieve(): void;
}

export const unlimitedMemory: ReaderMemory = { collect() {}, relieve() {} };

/** A full collection, where this runtime lets code ask for one. */
function collect(): void {
  const bun: unknown = Reflect.get(globalThis, "Bun");
  const gc: unknown =
    typeof bun === "object" && bun !== null
      ? Reflect.get(bun, "gc")
      : Reflect.get(globalThis, "gc");
  // Node exposes gc only with --expose-gc; without it, nothing is collected early.
  if (typeof gc === "function") Reflect.apply(gc, bun, [true]);
}

/**
 * For the reader process. Bun keeps freed heap resident for a while, and the daemon's watchdog
 * counts the whole process, so freed memory could push a reader over its limit and get a healthy
 * read blamed. Collecting before that point keeps the count to what is in use. In a worker
 * thread (`isMainThread` false) the process is the daemon's, so nothing is done.
 */
export function readerMemory(limitBytes: number | undefined): ReaderMemory {
  if (limitBytes === undefined || !isMainThread) return unlimitedMemory;
  return {
    collect,
    relieve() {
      if (process.memoryUsage().rss > limitBytes * 0.75) collect();
    },
  };
}
