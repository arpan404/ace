/** Node timers are an I/O boundary. Helpers accept a deterministic scheduler in tests. */
export const nodeScheduler = {
  schedule(callback: () => void, milliseconds: number): () => void {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

export type Scheduler = { after(ms: number, run: () => void): () => void };
export const systemScheduler: Scheduler = { after: (ms, run) => nodeScheduler.schedule(run, ms) };
