/** A scheduler owns one repeating callback and returns its cancellation handle. */
export type SearchScheduler = (flush: () => void) => () => void;

export function scheduleSearch(flush: () => void): () => void {
  const timer = setInterval(flush, 100);
  timer.unref();
  return () => clearInterval(timer);
}
