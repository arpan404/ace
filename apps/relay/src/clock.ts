/** Timer ownership is injected at every socket boundary. Policy code receives timestamps only. */
export interface Clock {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}
export function systemClock(now: () => number = () => performance.now()): Clock {
  return {
    now,
    schedule(delayMs, callback) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
}
export function delay(clock: Clock, milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      cancel();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const cancel = clock.schedule(milliseconds, finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}
