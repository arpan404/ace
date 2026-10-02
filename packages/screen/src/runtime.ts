/** Timer ownership is confined to this I/O boundary. */
export type Scheduler = { after(ms: number, run: () => void): () => void };
export const systemScheduler: Scheduler = {
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};
