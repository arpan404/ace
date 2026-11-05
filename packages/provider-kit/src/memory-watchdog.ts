import type { ResidentSampler } from "./resident-memory.ts";

export interface MemoryWatchdogOptions {
  pid: number;
  /** Past this many resident bytes the process is over its limit. */
  limitBytes: number;
  intervalMs: number;
  sample: ResidentSampler;
  /** Runs `callback` once after `milliseconds`; returns a cancel. */
  schedule: (callback: () => void, milliseconds: number) => () => void;
  /** Called once, with the reading that crossed the limit. Watching then stops. */
  onExceeded: (bytes: number) => void;
  /** A reading that failed; watching goes on. */
  onSampleError?: (error: unknown) => void;
}

/**
 * Polls a process's resident memory until it crosses a limit or the returned stop is called.
 * A reading of a process that has gone (undefined) is skipped; one that fails is reported and
 * skipped.
 */
export function watchMemory(options: MemoryWatchdogOptions): () => void {
  if (!(options.limitBytes > 0) || !(options.intervalMs > 0))
    throw new RangeError("Invalid memory watchdog limit or interval");
  let stopped = false;
  let cancel: (() => void) | undefined;
  const tick = async () => {
    cancel = undefined;
    const bytes = await options.sample(options.pid).catch((error: unknown) => {
      options.onSampleError?.(error);
      return undefined;
    });
    if (stopped) return;
    if (bytes !== undefined && bytes > options.limitBytes) {
      stopped = true;
      options.onExceeded(bytes);
      return;
    }
    cancel = options.schedule(() => void tick(), options.intervalMs);
  };
  cancel = options.schedule(() => void tick(), options.intervalMs);
  return () => {
    stopped = true;
    cancel?.();
  };
}
