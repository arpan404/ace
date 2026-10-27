/**
 * Synchronous same-tick guard for one-shot actions (pairing redeem).
 *
 * React state (`pairing`, `busy`) flushes asynchronously, so two presses in
 * the same tick both read `false` and both fire: a burned single-use pairing
 * code redeemed twice. This ref-style flag is set synchronously, so the
 * second same-tick attempt is refused. It is a UI re-entrancy lock only, not
 * a security boundary: the daemon still rejects a reused code, and callers
 * must `release()` in a `finally` so a settled attempt allows the next one.
 */

export interface SingleFlight {
  readonly held: boolean;
  /** Synchronously claim the action; false when an attempt is in flight. */
  tryAcquire(): boolean;
  /** Release after the attempt settles; always call from `finally`. */
  release(): void;
}

export function createSingleFlight(): SingleFlight {
  let held = false;
  return {
    get held() {
      return held;
    },
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
  };
}

/**
 * Coalescing flight for one-shot actions (pairing redeem).
 *
 * A legitimate double-tap on the *same* pairing request must redeem the
 * single-use code exactly once while both callers await the same outcome.
 * A *different* pairing request (different link code) must never share that
 * result: sharing would report the wrong host as paired while its own link
 * stays unredeemed. Distinct requests reject with the caller-supplied
 * `busyError` (or a generic Error when none is given) instead of resolving
 * to the wrong host.
 *
 * The flight is claimed synchronously, before any await, so two presses in
 * the same tick share or reject without a second `work()` invocation. `work`
 * runs once per flight; a settled flight allows the next attempt.
 *
 * Honesty limit (no native cancellation): the flight clears only when `work`
 * settles. A hung `work` blocks distinct requests until then, so callers
 * must bound `work` with `withLoadTimeout` at the call site. The timeout
 * surfaces a retryable error and frees the flight, but the orphaned redeem
 * still runs on: a late success may still save the entry, and a retry may
 * then hit the duplicate-pairing path. Never claim the timeout cancelled
 * the redeem.
 *
 * Keying: callers pass `key` when the args carry identity (pairing code +
 * device name). Without it, same-tick duplicates share (legacy behavior for
 * argless callers). With it, equal keys share and different keys reject.
 * The trailing `AbortSignal` (when present) never participates in the key:
 * the second caller's abort rejects only its own waiter, never the shared
 * redeem.
 */
export function createCoalescingFlight<TArgs extends unknown[], TResult>(
  work: (...args: TArgs) => Promise<TResult>,
  options?: {
    // eslint-disable-next-line no-unused-vars
    key?: (...args: TArgs) => string;
    /** Typed rejection for a *different* request arriving mid-flight. */
    busyError?: () => Error;
  },
): (...args: TArgs) => Promise<TResult> {
  let flight: Promise<TResult> | null = null;
  let flightKey: string | null = null;
  const keyOf = options?.key;
  const makeBusy =
    options?.busyError ?? (() => new Error("Pairing already in progress. Wait for it to finish."));
  return (...args: TArgs): Promise<TResult> => {
    const key = keyOf?.(...args) ?? null;
    if (flight !== null) {
      if (keyOf === undefined || key === flightKey) return shareWithSignal(flight, args);
      return Promise.reject(makeBusy());
    }
    const current = work(...args);
    flight = current;
    flightKey = key;
    const clear = () => {
      if (flight === current) {
        flight = null;
        flightKey = null;
      }
    };
    current.then(clear, clear);
    if (keyOf === undefined) return current;
    return shareWithSignal(current, args);
  };
}

/**
 * Attach the second caller's trailing AbortSignal to the shared flight
 * without letting it cancel the first caller's redeem. An already-aborted
 * second signal rejects immediately; a later abort rejects that waiter
 * while the underlying work runs on.
 */
function shareWithSignal<TArgs extends unknown[], TResult>(
  flight: Promise<TResult>,
  args: TArgs,
): Promise<TResult> {
  const signal = lastSignal(args);
  if (signal === undefined) return flight;
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<TResult>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    flight.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function lastSignal(args: readonly unknown[]): AbortSignal | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const candidate = args[index];
    if (candidate instanceof AbortSignal) return candidate;
    if (
      candidate !== null &&
      typeof candidate === "object" &&
      typeof (candidate as { aborted?: unknown }).aborted === "boolean" &&
      typeof (candidate as { addEventListener?: unknown }).addEventListener === "function"
    ) {
      return candidate as AbortSignal;
    }
  }
  return undefined;
}

function abortedError(): Error {
  const error = new Error("Pairing cancelled.");
  (error as { code?: string }).code = "aborted";
  return error;
}
