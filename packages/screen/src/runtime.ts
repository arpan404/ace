/** Node timers are an I/O boundary. Helpers accept a deterministic scheduler in tests. */
export const nodeScheduler = {
  schedule(callback: () => void, milliseconds: number): () => void {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};
