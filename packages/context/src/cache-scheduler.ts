/** I/O boundary: at most one retry is owned by each cached workspace. */
export interface CacheScheduler {
  after(delayMs: number, task: () => Promise<void>): () => void;
}
export const cacheScheduler: CacheScheduler = {
  after(delayMs, task) {
    const timer = setTimeout(() => {
      // Each task reports its own failure; this timer only owns the retry.
      void task().catch(() => {});
    }, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
/** Bounded exponential backoff, independent of filesystem or clocks. */
export function recoveryDelay(failures: number): number {
  return Math.min(5000, 100 * 2 ** Math.min(6, failures - 1));
}
