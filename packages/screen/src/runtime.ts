/** Node timers are an I/O boundary. Helpers accept a deterministic scheduler in tests. */
export const nodeScheduler = {
  schedule(callback: () => void, milliseconds: number): () => void {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** The system's wall clock: an I/O boundary, injected where frames are stamped. */
export const systemWallClock = (): number => Date.now();

export type Scheduler = { after(ms: number, run: () => void): () => void };
export const systemScheduler: Scheduler = { after: (ms, run) => nodeScheduler.schedule(run, ms) };
