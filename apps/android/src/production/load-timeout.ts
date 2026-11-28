/**
 * Timeout race for production loads that must never hang the UI.
 *
 * `ProductionRoot` retries only caught exceptions today: a `startup.load()`
 * or `openDatabaseAsync` that never settles leaves an opaque screen with no
 * Retry. Racing the work against a timer turns a hang into a catchable
 * failure so the existing retry path fires.
 *
 * Honesty limits (not cancellable): the timer never stops the underlying
 * work — there is no cancellation API under `openDatabaseAsync` or the
 * manager's serialized `load()`. A timed-out database open still resolves
 * later (the `onOrphanSettled` hook lets the caller close that orphaned
 * handle), and a timed-out `startup.load()` still reconciles into the same
 * manager when it eventually runs (the reconcile is serialized and
 * idempotent, so the retry queues behind it instead of duplicating owners).
 * Stale generations must therefore never `disconnectAll` or write state:
 * see the generation guard in `ProductionRoot`.
 */

export const PRODUCTION_LOAD_TIMEOUT_MS = 15_000;

export class LoadTimeoutError extends Error {
  constructor(ms: number = PRODUCTION_LOAD_TIMEOUT_MS) {
    super(`The connection timed out after ${ms}ms.`);
    this.name = "LoadTimeoutError";
  }
}

/** Where timed-out work eventually went, for orphan cleanup. */
export type OrphanOutcome<T> =
  | { readonly settled: "resolved"; readonly value: T }
  | { readonly settled: "rejected"; readonly error: unknown };

/**
 * Resolve with `work`, or reject with `LoadTimeoutError` after `ms`.
 * When the timeout wins, `onOrphanSettled` (when given) runs with the work's
 * late outcome so the caller can release the orphaned resource (e.g. close
 * a late database handle). Without it the late rejection is still swallowed
 * so no unhandled rejection escapes; the late work itself always runs on.
 */
export function withLoadTimeout<T>(
  work: Promise<T>,
  ms: number = PRODUCTION_LOAD_TIMEOUT_MS,
  onOrphanSettled?: ((outcome: OrphanOutcome<T>) => void) | undefined,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (onOrphanSettled !== undefined) {
        work.then(
          (value) => onOrphanSettled({ settled: "resolved", value }),
          (error: unknown) => onOrphanSettled({ settled: "rejected", error }),
        );
      } else {
        // Nobody can cancel the work; at least never leak an unhandled
        // rejection when the timeout wins the race.
        work.then(undefined, () => undefined);
      }
      reject(new LoadTimeoutError(ms));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
