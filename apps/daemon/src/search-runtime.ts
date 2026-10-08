/** A scheduler owns one repeating callback and returns its cancellation handle. */
export type SearchScheduler = (flush: () => void) => () => void;

export function scheduleSearch(flush: () => void): () => void {
  const timer = setInterval(flush, 100);
  timer.unref();
  return () => clearInterval(timer);
}

/** Store appends wake the writer; settled indexes own no repeating timer. */
export function createSearchMaintenance(
  scheduler: SearchScheduler,
  flush: () => void,
  hasWork: () => boolean,
) {
  let stop: (() => void) | undefined;
  let closed = false;
  const wake = () => {
    if (closed || stop) return;
    stop = scheduler(() => {
      if (closed) return;
      flush();
      if (!hasWork()) {
        const cancel = stop;
        stop = undefined;
        cancel?.();
      }
    });
  };
  wake();
  return {
    wake,
    close() {
      closed = true;
      const cancel = stop;
      stop = undefined;
      cancel?.();
    },
  };
}
