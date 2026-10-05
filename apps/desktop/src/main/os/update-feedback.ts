import type { UpdateStatus } from "../../shared/contract.ts";

/** Schedules a callback; returns its cancel. Injected so tests control time. */
export interface Timers {
  set(delayMs: number, callback: () => void): () => void;
}

export const updateCheckTimeoutMs = 10_000;

/**
 * "Check for Updates…" from the menu: reports `checking` at once, then the result, and gives
 * up with an error after `timeoutMs`, so the person always hears back. A result that arrives
 * after the timeout is dropped: they have already been told.
 */
export function checkWithFeedback(options: {
  check(): Promise<UpdateStatus>;
  report(status: UpdateStatus): void;
  timers: Timers;
  timeoutMs?: number;
}): Promise<void> {
  options.report({ state: "checking" });
  return new Promise((resolve) => {
    let settled = false;
    let cancel: (() => void) | undefined;
    const finish = (status: UpdateStatus) => {
      if (settled) return;
      settled = true;
      cancel?.();
      options.report(status);
      resolve();
    };
    cancel = options.timers.set(options.timeoutMs ?? updateCheckTimeoutMs, () =>
      finish({ state: "error", message: "The update check timed out." }),
    );
    Promise.resolve()
      .then(() => options.check())
      .then(finish, (error: unknown) =>
        finish({ state: "error", message: error instanceof Error ? error.message : String(error) }),
      );
  });
}
