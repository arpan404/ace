/**
 * Runs `task` when the browser is idle, bounded by `fallbackMs`. Where
 * `requestIdleCallback` exists the idle callback races a `setTimeout` safety
 * net: if idle never comes (a busy main thread, or a browser like ace's
 * built-in one where idle callbacks never fire), the timeout still runs the
 * task. Whichever fires first wins and cancels the other, so `task` runs
 * exactly once. Without `requestIdleCallback` (Safari, jsdom) the task runs
 * after `fallbackMs`. Returns a cancel function that stops both. For warming
 * code the first paint left out, so it is ready before anyone needs it.
 */

/** The platform pieces the idle race needs, injected so tests can drive it. */
export interface IdleScheduler {
  requestIdleCallback?:
    | ((callback: () => void, options?: { timeout: number }) => number)
    | undefined;
  cancelIdle?: ((handle: number) => void) | undefined;
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * Pure core: race the idle callback (bounded by `idleTimeoutMs`) against a
 * `setTimeout` safety net, or wait `noIdleDelayMs` where there is no idle
 * callback. The first to fire runs `work` exactly once and cancels the other;
 * the returned cancel stops both before either fires.
 */
export function scheduleIdleWork(
  scheduler: IdleScheduler,
  work: () => void,
  idleTimeoutMs: number,
  noIdleDelayMs: number,
): () => void {
  let settled = false;
  let idleId: number | undefined;
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    settled = true;
    if (idleId !== undefined) scheduler.cancelIdle?.(idleId);
    if (timerId !== undefined) scheduler.clearTimeout(timerId);
  };
  const run = () => {
    if (settled) return;
    settled = true;
    if (idleId !== undefined) scheduler.cancelIdle?.(idleId);
    if (timerId !== undefined) scheduler.clearTimeout(timerId);
    work();
  };
  if (scheduler.requestIdleCallback) {
    idleId = scheduler.requestIdleCallback(run, { timeout: idleTimeoutMs });
    timerId = scheduler.setTimeout(run, idleTimeoutMs);
  } else {
    timerId = scheduler.setTimeout(run, noIdleDelayMs);
  }
  return cancel;
}

export function whenIdle(task: () => void, fallbackMs = 2_000): () => void {
  const scheduler: IdleScheduler =
    typeof requestIdleCallback === "function"
      ? {
          requestIdleCallback: (callback, options) => requestIdleCallback(callback, options),
          ...(typeof cancelIdleCallback === "function"
            ? { cancelIdle: (handle: number) => cancelIdleCallback(handle) }
            : {}),
          setTimeout: (callback, ms) => setTimeout(callback, ms),
          clearTimeout: (id) => clearTimeout(id),
        }
      : {
          setTimeout: (callback, ms) => setTimeout(callback, ms),
          clearTimeout: (id) => clearTimeout(id),
        };
  return scheduleIdleWork(scheduler, task, fallbackMs, fallbackMs);
}
