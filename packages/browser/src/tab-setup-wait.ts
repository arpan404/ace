import { BrowserActionError } from "./action-error.ts";
import type { NavigationClock } from "./navigation.ts";

/**
 * The longest a command waits for the backend to finish setting up the tab it runs on. Setup is
 * a handful of CDP calls (the origin guard, page domains), milliseconds on an idle machine.
 */
export const tabSetupWaitMs = 30_000;

/** Settles with the tab's setup, or fails once the wait runs out or the caller gives up. */
export function untilTabReady(
  setup: Promise<void>,
  clock: NavigationClock,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      cancel();
      signal?.removeEventListener("abort", aborted);
      if (error === undefined) resolve();
      else reject(error);
    };
    const aborted = () => finish(signal?.reason);
    const cancel = clock.set(tabSetupWaitMs, () => finish(new BrowserActionError("timeout")));
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, { once: true });
    setup.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
  });
}
